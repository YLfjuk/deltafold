import { header, headerPrefix } from "../../configs/gen.config.ts";

/** One version the index imports: the module's version id and the name it exports. */
export type IndexEntry = { readonly id: string; readonly exportName: string };

const localNames = (entries: ReadonlyArray<IndexEntry>): ReadonlyArray<string> => {
	const used = new Set<string>(["versions"]);

	return entries.map((entry) => {
		const base = `v${entry.id.replace(/[^\w$]/g, "_")}`;
		let name = base;
		for (let suffix = 2; used.has(name); suffix++) name = `${base}_${suffix}`;
		used.add(name);
		return name;
	});
};

/** Renders the index module, which exports the generated versions in release order. */
export const renderIndex = (
	entries: ReadonlyArray<IndexEntry>,
	firstLine: string = header,
): string => {
	const names = localNames(entries);
	const imports = entries.map(
		(entry, index) =>
			`import { ${entry.exportName} as ${names[index]} } from ${JSON.stringify(`./${entry.id}.ts`)};`,
	);

	return `${[firstLine, ...imports, "", `export const versions = [${names.join(", ")}] as const;`].join("\n")}\n`;
};

const importLine = /^import \{ ([\w$]+) as [\w$]+ \} from ("(?:[^"\\]|\\.)*");$/;

const idOf = (quoted: string): string | undefined => {
	const specifier: unknown = JSON.parse(quoted);
	return typeof specifier === "string" && specifier.startsWith("./") && specifier.endsWith(".ts")
		? specifier.slice(2, -3)
		: undefined;
};

/**
 * Reads an index this package rendered, by any version of it. Anything else, including a
 * hand-edited index, gives `undefined`.
 */
export const parseIndex = (text: string): ReadonlyArray<IndexEntry> | undefined => {
	const [firstLine = "", ...rest] = text.split("\n");
	if (!firstLine.startsWith(headerPrefix)) return undefined;
	const entries: Array<IndexEntry> = [];
	for (const line of rest) {
		const match = importLine.exec(line);
		if (match === null) break;
		const [, exportName = "", quoted = ""] = match;
		const id = idOf(quoted);
		if (id === undefined) return undefined;
		entries.push({ id, exportName });
	}

	return renderIndex(entries, firstLine) === text ? entries : undefined;
};
