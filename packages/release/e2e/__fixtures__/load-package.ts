import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

import { Package } from "deltafold";

const require = createRequire(import.meta.url);
let loadCount = 0;

const isFixturePackage = (value: unknown): value is Package.Package<never> =>
	Package.isPackage(value) && value.history.migrations.length === 0;

/** Load a fresh snapshot using Node's module loader with files supplied in memory. */
export const loadPackage = (files: ReadonlyMap<string, string>, member: "widgets" | "adapter") => {
	const root = new URL(`reload-${++loadCount}/`, import.meta.url);
	const entry = new URL(`packages/${member}/.deltafold/package.ts`, root);
	const entryPath = fileURLToPath(entry);
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (specifier === entryPath) return { url: entry.href, shortCircuit: true };
			const parent = context.parentURL;
			const inWorkspace = parent?.startsWith(root.href) ?? false;
			if (inWorkspace && specifier.startsWith(".")) {
				return { url: new URL(specifier, parent).href, shortCircuit: true };
			}
			return next(specifier, {
				...context,
				parentURL: inWorkspace ? import.meta.url : parent,
				conditions: [...context.conditions, "@deltafold/dev.src"],
			});
		},
		load(url, context, next) {
			if (!url.startsWith(root.href)) return next(url, context);
			const path = decodeURIComponent(url.slice(root.href.length));
			const source = files.get(path);
			if (source === undefined) throw new Error(`Missing fixture module: ${path}`);
			return path.endsWith(".json")
				? { format: "json", source, shortCircuit: true }
				: { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
		},
	});
	try {
		const exports: unknown = require(entryPath);
		const pkg: unknown =
			typeof exports === "object" && exports !== null ? Reflect.get(exports, member) : null;
		if (!isFixturePackage(pkg)) throw new Error(`No fixture package export: ${member}`);
		return pkg;
	} finally {
		hooks.deregister();
	}
};
