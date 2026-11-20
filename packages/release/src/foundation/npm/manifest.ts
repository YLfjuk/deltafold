import { Predicate } from "effect";

// Reading and editing npm package.json manifests as text.

/** The dependency fields that become requirements. */
export const fields = [
	"dependencies",
	"peerDependencies",
	"optionalDependencies",
	"devDependencies",
] as const;

export type Manifest = {
	readonly name: string | undefined;
	readonly version: string | undefined;
	readonly private: boolean;
	readonly ranges: ReadonlyArray<{
		readonly field: string;
		readonly dependency: string;
		readonly range: string;
	}>;
};

/** Reads the fields release planning uses, or `undefined` for text that is not a JSON object. */
export const readManifest = (text: string): Manifest | undefined => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Predicate.isObject(parsed)) return undefined;
	const record: { readonly [key: string]: unknown } = parsed;
	const ranges = fields.flatMap((field) => {
		const value = record[field];
		if (!Predicate.isObject(value)) return [];

		return Object.entries(value).flatMap(([dependency, range]) =>
			typeof range === "string" ? [{ field, dependency, range }] : [],
		);
	});

	return {
		name: typeof record.name === "string" ? record.name : undefined,
		version: typeof record.version === "string" ? record.version : undefined,
		private: record.private === true,
		ranges,
	};
};

type Frame = {
	readonly object: boolean;
	readonly path: ReadonlyArray<string>;
	key: string | undefined;
	expectKey: boolean;
};

/** A string as JSON string content, without the surrounding quotes. */
export const jsonContent = (value: string) => JSON.stringify(value).slice(1, -1);

/**
 * Finds the string value at a key path in JSON text, such as `["version"]` or
 * `["dependencies", "@acme/widgets"]`, counting from the top-level object. Nested
 * properties with the same name are never matched. Returns the span inside the quotes.
 */
export const locate = (text: string, path: ReadonlyArray<string>) => {
	const stack: Array<Frame> = [];
	const here = (): ReadonlyArray<string> => {
		const top = stack.at(-1);
		if (top === undefined) return [];
		return top.key === undefined ? top.path : [...top.path, top.key];
	};
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === '"') {
			let end = index + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			const value: unknown = JSON.parse(text.slice(index, end + 1));
			const top = stack.at(-1);
			if (typeof value === "string" && top?.object === true && top.expectKey) {
				top.key = value;
				top.expectKey = false;
			} else if (typeof value === "string") {
				const keys = here();
				if (
					keys.length === path.length &&
					keys.every((key, position) => key === path[position])
				) {
					return { value, start: index + 1, end };
				}
			}
			index = end;
		} else if (char === "{" || char === "[") {
			stack.push({
				object: char === "{",
				path: char === "{" ? here() : [...here(), "[]"],
				key: undefined,
				expectKey: char === "{",
			});
		} else if (char === "}" || char === "]") {
			stack.pop();
		} else if (char === ",") {
			const top = stack.at(-1);
			if (top?.object === true) {
				top.key = undefined;
				top.expectKey = true;
			}
		}
	}

	return undefined;
};

/** Finds a dependency's range string inside one top-level dependency field. */
export const findRange = (text: string, field: string, dependency: string) => {
	const found = locate(text, [field, dependency]);
	return found === undefined
		? undefined
		: { range: found.value, start: found.start, end: found.end };
};
