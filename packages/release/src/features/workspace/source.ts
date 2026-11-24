import type { Version } from "deltafold";
import * as GenConfig from "../../configs/gen.ts";
import { issue } from "../../foundation/error.ts";
import type { Issue } from "../../foundation/error.ts";
import type { Release } from "../planning/index.ts";
import * as paths from "./paths.ts";

/**
 * A pending change module: its workspace-relative path, and its text.
 *
 * @since 0.0.1
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
 * @since 0.0.1
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

const statementStart =
	/^(?:export|import|const|let|var|function|class|async|type|interface|enum|declare|namespace|abstract)\b/;

/**
 * The end of the first top-level statement: just after a `;` outside brackets, strings,
 * template literals, and comments, or the end of the text. A line that starts another
 * statement at the top level ends it too, so a missing semicolon cannot hide a second
 * statement. `comma` reports a top-level comma, which declares another binding in the
 * same statement. Returns `undefined` for unbalanced text.
 */
const statementEnd = (
	text: string,
): { readonly end: number; readonly comma: boolean } | undefined => {
	let depth = 0;
	let comma = false;
	// Each entry is the bracket depth at which a template's `${` was opened.
	const templates: Array<number> = [];
	let inTemplate = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inTemplate) {
			if (char === "\\") index++;
			else if (char === "`") inTemplate = false;
			else if (char === "$" && text[index + 1] === "{") {
				templates.push(depth);
				depth++;
				inTemplate = false;
				index++;
			}
			continue;
		}
		if (char === "/" && text[index + 1] === "/") {
			const newline = text.indexOf("\n", index);
			index = newline === -1 ? text.length : newline - 1;
		} else if (char === "/" && text[index + 1] === "*") {
			const close = text.indexOf("*/", index + 2);
			if (close === -1) return undefined;
			index = close + 1;
		} else if (char === '"' || char === "'") {
			let close = index + 1;
			while (close < text.length && text[close] !== char)
				close += text[close] === "\\" ? 2 : 1;
			if (close >= text.length) return undefined;
			index = close;
		} else if (char === "/") {
			// A lone slash starts a regular expression or a division. Telling them apart needs
			// a parser, and a regular expression can hide a comma or a comment, so refuse both.
			return undefined;
		} else if (char === "`") inTemplate = true;
		else if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") {
			depth--;
			if (depth < 0) return undefined;
			if (char === "}" && templates.at(-1) === depth) {
				templates.pop();
				inTemplate = true;
			}
		} else if (char === ";" && depth === 0) return { end: index + 1, comma };
		else if (char === "," && depth === 0) comma = true;
		else if (char === "\n" && depth === 0 && index > 0) {
			const next = text.slice(index + 1).replace(/^[ \t]*/, "");
			if (statementStart.test(next)) return { end: index, comma };
		}
	}

	return depth === 0 && !inTemplate ? { end: text.length, comma } : undefined;
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
 * @since 0.0.1
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

	const statement = statementEnd(rest);
	if (statement === undefined || rest.slice(statement.end).replace(leading, "") !== "") {
		return unsupported(
			source.path,
			"only the exported change declaration may follow the imports, and it cannot contain regular expressions or division; other statements would be copied into the version module.",
		);
	}
	if (statement.comma) {
		return unsupported(
			source.path,
			"the declaration statement binds more than one name; the other bindings would be copied into the version module.",
		);
	}
	const end = statement.end;

	return {
		path: source.path,
		imports,
		name: head[1],
		changeId: id[2],
		text: rest.slice(0, end).trim(),
	};
};

/**
 * The directory part of a path. Absolute POSIX and Windows drive paths keep their prefix.
 *
 * @since 0.0.1
 */
export const dirname: (path: string) => string = paths.dirname;

/**
 * Joins and normalizes path parts with "/". An absolute part restarts the path.
 *
 * @since 0.0.1
 */
export const join: (...parts: ReadonlyArray<string>) => string = paths.join;

/**
 * The module specifier from a directory to a file, starting with `./` or `../`.
 *
 * @since 0.0.1
 */
export const relative: (fromDirectory: string, to: string) => string = paths.relative;

/** The files a relative import may resolve to, with or without an extension. */
const resolutions = (target: string): ReadonlyArray<string> => {
	// An emitted extension names its source: .js is .ts or .tsx, .jsx is .tsx, .mjs is .mts.
	const emitted = /\.(js|jsx|mjs|cjs)$/.exec(target);
	const stem = emitted === null ? target : target.slice(0, -emitted[0].length);
	const sources: Record<string, ReadonlyArray<string>> = {
		js: [".ts", ".tsx"],
		jsx: [".tsx"],
		mjs: [".mts"],
		cjs: [".cts"],
	};

	return [
		target,
		...(emitted?.[1] === undefined
			? []
			: (sources[emitted[1]] ?? []).map((extension) => `${stem}${extension}`)),
		...[".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx"].map(
			(suffix) => `${target}${suffix}`,
		),
	];
};

/** @since 0.0.1 */
export type RenderInput = {
	readonly path: string;
	readonly version: Version.Version;
	readonly previous: { readonly specifier: string; readonly exportName: string };
	readonly declarations: ReadonlyArray<Declaration>;
	readonly exportName: string;
	/** Range edits in the package's manifest, recorded as release metadata. */
	readonly dependencies: ReadonlyArray<Release.DependencyUpdate>;
	/** Pending modules this release removes. Imports between them cannot be relocated. */
	readonly consumed: ReadonlyArray<string>;
};

/**
 * Renders a generated version module from copied declarations. Relative imports are
 * re-pointed from the new location; nothing is evaluated.
 *
 * @since 0.0.1
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
	bind("release", "the release metadata export");

	const imports: Array<string> = [];
	for (const declaration of input.declarations) {
		for (const entry of declaration.imports) {
			let text = entry.text;
			if (entry.specifier.startsWith(".")) {
				const target = join(dirname(declaration.path), entry.specifier);
				if (resolutions(target).some((candidate) => input.consumed.includes(candidate))) {
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
		GenConfig.header,
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
	if (input.dependencies.length > 0) {
		const records = input.dependencies.map(({ dependency, field, from, to, version }) => ({
			dependency,
			field,
			from,
			to,
			version,
		}));
		lines.push(
			"",
			`export const release = Version.withMetadata(${input.exportName}, {`,
			`\tdependencies: ${JSON.stringify(records)},`,
			"});",
		);
	}

	return { text: `${lines.join("\n")}\n` };
};
