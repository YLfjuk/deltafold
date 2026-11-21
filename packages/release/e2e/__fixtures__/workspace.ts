import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

import releaseManifest from "@deltafold/release/package.json" with { type: "json" };
import { memoryFs } from "../../test/__fixtures__/memory-fs.ts";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(fixtureDirectory, "workspace").replaceAll("\\", "/");

export const fixtureText = (path: string) =>
	readFileSync(resolve(fixtureDirectory, path), "utf8").replaceAll("\r\n", "\n");

export const generatedFixtureText = (path: string) =>
	fixtureText(path).replace("{{releaseVersion}}", releaseManifest.version);

export const workspace = (options?: Parameters<typeof memoryFs>[1]) => {
	const initial = Object.fromEntries(
		readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const path = resolve(entry.parentPath, entry.name).replaceAll("\\", "/");
				const relative = path.slice(root.length + 1);
				return [relative, fixtureText(`workspace/${relative}`)];
			}),
	);
	return memoryFs(initial, options);
};

/** TypeScript reads release output from memory and dependencies through normal package exports. */
export const diagnostics = (files: ReadonlyMap<string, string>) => {
	const configPath = `${root}/tsconfig.json`;
	const virtual = createVirtualFileSystem({
		...Object.fromEntries([...files].map(([path, text]) => [`${root}/${path}`, text])),
		[configPath]: JSON.stringify({
			extends: resolve(fixtureDirectory, "../../../../tsconfig.base.json"),
			compilerOptions: {
				lib: ["ES2022", "DOM"],
				paths: {
					"@deltafold/release": [
						resolve(
							fileURLToPath(
								new URL(
									".",
									import.meta.resolve("@deltafold/release/package.json"),
								),
							),
							releaseManifest.exports["."]["@deltafold/dev.src"],
						),
					],
				},
			},
			files: [...files.keys()].filter((path) => path.endsWith(".ts")),
		}),
	});
	const inWorkspace = (path: string) => path.replaceAll("\\", "/").startsWith(`${root}/`);
	const api = new API({
		cwd: root,
		fs: {
			readFile: (path) =>
				inWorkspace(path) ? (virtual.readFile?.(path) ?? null) : undefined,
			fileExists: (path) => (inWorkspace(path) ? virtual.fileExists?.(path) : undefined),
			directoryExists: (path) =>
				inWorkspace(path) ? virtual.directoryExists?.(path) : undefined,
			getAccessibleEntries: (path) =>
				path === root || inWorkspace(path)
					? virtual.getAccessibleEntries?.(path)
					: undefined,
		},
	});
	try {
		using snapshot = api.updateSnapshot({ openProjects: [configPath] });
		const project = snapshot.getProject(configPath);
		if (project === undefined) throw new Error("Missing fixture compiler project");
		return [
			...project.program.getConfigFileParsingDiagnostics(),
			...project.program.getProgramDiagnostics(),
			...project.program.getSyntacticDiagnostics(),
			...project.program.getSemanticDiagnostics(),
		].map((diagnostic) => diagnostic.text);
	} finally {
		api.close();
	}
};
