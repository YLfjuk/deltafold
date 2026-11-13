import type { Version } from "deltafold";
import { issue, type Issue } from "./error.ts";
import type { Line } from "./version-strategy.ts";

/**
 * A pending change module: its path relative to the working directory, and its text.
 *
 * @since @next
 */
export type PendingSource = { readonly path: string; readonly text: string };

type Import = {
	readonly text: string;
	readonly specifier: string;
	readonly locals: ReadonlyArray<string>;
};

/**
 * A pending module in the supported shape: imports, then exactly one
 * `export const name = <factory>.make("id", ...)` declaration.
 *
 * @since @next
 */
export type Declaration = {
	readonly path: string;
	readonly imports: ReadonlyArray<Import>;
	readonly name: string;
	readonly changeId: string;
	readonly text: string;
};

const importPattern =
	/^import\s+(?:(type)\s+)?([\s\S]*?)\s+from\s+(["'])([^"']+)\3\s*;?|^import\s+(["'])([^"']+)\5\s*;?/;
const leading = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

const localsOf = (clause: string): ReadonlyArray<string> => {
	const locals: Array<string> = [];
	const named = /\{([\s\S]*)\}/.exec(clause);
	if (named?.[1] !== undefined) {
		for (const part of named[1].split(",")) {
			const binding = part.trim().replace(/^type\s+/, "");
			if (binding === "") continue;
			locals.push(
				binding
					.split(/\s+as\s+/)
					.at(-1)
					?.trim() ?? binding,
			);
		}
	}
	const rest = clause
		.replace(/\{[\s\S]*\}/, "")
		.replace(/,/g, " ")
		.trim();
	const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(rest);
	if (namespace?.[1] !== undefined) locals.push(namespace[1]);
	const defaultName = /^([A-Za-z_$][\w$]*)/.exec(rest);
	if (defaultName?.[1] !== undefined && defaultName[1] !== "type") locals.push(defaultName[1]);

	return locals;
};

const unsupported = (path: string, detail: string): Issue =>
	issue(
		"UnsupportedRelocation",
		`${path}: ${detail} Declare one change per pending module, after its imports.`,
		[path],
	);

/**
 * Reads a pending module without evaluating it. Unsupported shapes are reported, never
 * rewritten.
 *
 * @since @next
 */
export const scan = (source: PendingSource): Declaration | Issue => {
	const imports: Array<Import> = [];
	let rest = source.text;
	for (;;) {
		rest = rest.slice(leading.exec(rest)?.[0].length ?? 0);
		const match = importPattern.exec(rest);
		if (match === null) break;
		const specifier = match[4] ?? match[6] ?? "";
		imports.push({
			text: match[0].trim().replace(/;?$/, ";"),
			specifier,
			locals: match[2] === undefined ? [] : localsOf(match[2]),
		});
		rest = rest.slice(match[0].length);
	}
	for (const [pattern, detail] of [
		[/\bimport\s*\(/, "dynamic import() is not relocated."],
		[/\bimport\.meta\b/, "import.meta depends on the module location."],
		[/\brequire\s*\(/, "require() is not relocated."],
		[/^\s*import\s/m, "imports must precede the declaration."],
		[/^\s*export\s+(?:\*|default|\{)/m, "re-exports and default exports are not supported."],
	] as const) {
		if (pattern.test(rest)) return unsupported(source.path, detail);
	}
	const declarations = rest.match(/^\s*export\s+/gm) ?? [];
	const head = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/.exec(rest);
	if (head?.[1] === undefined || declarations.length !== 1) {
		return unsupported(source.path, "expected exactly one exported const declaration.");
	}
	const id = /\.make\(\s*(["'])([^"'\\]+)\1/.exec(rest);
	if (id?.[2] === undefined) {
		return unsupported(
			source.path,
			"the change id must be the first argument of a make(...) call, as a string literal.",
		);
	}

	return { path: source.path, imports, name: head[1], changeId: id[2], text: rest.trim() };
};

const normalize = (path: string): string => {
	const parts: Array<string> = [];
	for (const part of path.replace(/\\/g, "/").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
		else parts.push(part);
	}

	return parts.join("/");
};

/** @since @next */
export const dirname = (path: string): string => normalize(path).split("/").slice(0, -1).join("/");

/** @since @next */
export const join = (...parts: ReadonlyArray<string>): string =>
	normalize(parts.filter((part) => part !== "").join("/"));

/** @since @next */
export const relative = (fromDirectory: string, to: string): string => {
	const from = normalize(fromDirectory)
		.split("/")
		.filter((part) => part !== "");
	const target = normalize(to).split("/");
	let shared = 0;
	while (shared < from.length && shared < target.length - 1 && from[shared] === target[shared])
		shared++;
	const path = [...from.slice(shared).map(() => ".."), ...target.slice(shared)].join("/");

	return path.startsWith(".") ? path : `./${path}`;
};

/** @since @next */
export type RenderInput = {
	readonly path: string;
	readonly version: Version.Version;
	readonly previous: { readonly specifier: string; readonly exportName: string };
	readonly declarations: ReadonlyArray<Declaration>;
	readonly exportName: string;
	readonly line: Line | undefined;
	/** Pending modules this release removes. Imports between them cannot be relocated. */
	readonly consumed: ReadonlyArray<string>;
};

/**
 * Renders a generated version module from copied declarations. Relative imports are
 * re-pointed from the new location; nothing is evaluated.
 *
 * @since @next
 */
export const render = (
	input: RenderInput,
): { readonly text: string } | { readonly issues: ReadonlyArray<Issue> } => {
	const issues: Array<Issue> = [];
	const directory = dirname(input.path);
	const bound = new Map<string, string>();
	const bind = (local: string, origin: string) => {
		const existing = bound.get(local);
		if (existing !== undefined && existing !== origin) {
			issues.push(
				issue(
					"NameCollision",
					`${input.path}: "${local}" is bound by both ${existing} and ${origin}.`,
					[input.path, local],
				),
			);
		}
		bound.set(local, origin);
	};

	const deltafoldImport = `import { Version } from "deltafold";`;
	const previousImport = `import { ${input.previous.exportName} as previous } from "${input.previous.specifier}";`;
	bind("Version", deltafoldImport);
	bind("previous", previousImport);
	bind(input.exportName, "the version export");
	bind("prerelease", "the prerelease export");

	const imports: Array<string> = [];
	for (const declaration of input.declarations) {
		for (const entry of declaration.imports) {
			let text = entry.text;
			if (entry.specifier.startsWith(".")) {
				const target = join(dirname(declaration.path), entry.specifier);
				if (input.consumed.includes(target)) {
					issues.push(
						issue(
							"UnsupportedRelocation",
							`${declaration.path} imports the pending module ${target}, which this release removes.`,
							[declaration.path, target],
						),
					);
					continue;
				}
				text = text
					.replace(`"${entry.specifier}"`, `"${relative(directory, target)}"`)
					.replace(`'${entry.specifier}'`, `"${relative(directory, target)}"`);
			}
			for (const local of entry.locals) bind(local, text);
			if (!imports.includes(text)) imports.push(text);
		}
		bind(declaration.name, declaration.path);
	}
	if (issues.length > 0) return { issues };

	const names = input.declarations.map((declaration) => declaration.name);
	const lines = [
		"// Generated by @deltafold/release from pending changes. It is ordinary source.",
		deltafoldImport,
		previousImport,
		...imports.filter((text) => text !== deltafoldImport),
		"",
		...input.declarations.flatMap((declaration) => [declaration.text, ""]),
		`export const ${input.exportName} = Version.make(${JSON.stringify(input.version.id)}, {`,
		"\tprevious,",
		`\tchanges: [${names.join(", ")}],`,
		"});",
	];
	if (input.line !== undefined) {
		lines.push("", `export const prerelease = ${JSON.stringify(input.line)} as const;`);
	}

	return { text: `${lines.join("\n")}\n` };
};
