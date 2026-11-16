import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { isImportDeclaration, isStringLiteral } from "typescript-7.1/ast/is";
import type { Checker, Program, Symbol } from "typescript-7.1/async";

import { TypeScript } from "@deltafold/typescript";
import { Action } from "deltafold";
import { fixture, outcomeOf, readFiles, transformFailed } from "./__fixtures__/workspace.ts";

type RenameField = {
	readonly module: string;
	readonly type: string;
	readonly from: string;
	readonly to: string;
	readonly include: ReadonlyArray<string>;
};
const RenameField = Action.define<RenameField>("ts.rename-field");

const renameA1 = RenameField.make("rename-a1", {
	module: "@acme/widgets",
	type: "A",
	from: "a1",
	to: "a2",
	include: ["packages/*/src/**/*.ts"],
});

class MissingMember extends Error {}

/**
 * Finds member `from` of export `type` of `module` through any program file that
 * imports the module. Returns undefined when the project never imports it.
 */
const findMember = async (
	program: Program,
	checker: Checker,
	{ module, type, from }: RenameField,
): Promise<Symbol | undefined> => {
	for (const name of await program.getSourceFileNames()) {
		const file = String(name);
		if (file.endsWith(".d.ts")) continue;
		const sourceFile = await program.getSourceFile(file);
		const declaration = sourceFile?.statements.find(
			(statement) =>
				isImportDeclaration(statement) &&
				isStringLiteral(statement.moduleSpecifier) &&
				statement.moduleSpecifier.text === module,
		);
		if (declaration === undefined || !isImportDeclaration(declaration)) continue;
		const moduleSymbol = await checker.getSymbolAtLocation(declaration.moduleSpecifier);
		if (moduleSymbol === undefined) throw new MissingMember(`${module} does not resolve`);
		const exported = (await checker.getExportsOfModule(moduleSymbol)).find(
			(symbol) => symbol.name === type,
		);
		const members = (await exported?.getMembers())?.values() ?? [];
		const member = [...members].find((symbol) => symbol.name === from);
		if (member === undefined) throw new MissingMember(`${module} has no ${type}.${from}`);

		return member;
	}

	return undefined;
};

const tsconfig = JSON.stringify({
	compilerOptions: { strict: true, module: 199, moduleResolution: 99 },
	include: ["src"],
});

const files = {
	"node_modules/@acme/widgets/package.json": JSON.stringify({
		name: "@acme/widgets",
		type: "module",
		exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
	}),
	"node_modules/@acme/widgets/index.d.ts":
		"export interface A { a1: number; other: string }\nexport declare function load(): Promise<A>;\n",
	"node_modules/@acme/widgets/index.js": "export {};\n",
	"packages/app/tsconfig.json": tsconfig,
	"packages/app/src/config.ts":
		'import type { A } from "@acme/widgets";\n\nexport const settings: A = { a1: 1, other: "x" };\n',
	"packages/app/src/factory.ts":
		'import { load, type A } from "@acme/widgets";\n\nexport const make = async () => load();\n\nexport class Holder {\n\tconstructor(readonly inner: A) {}\n\tget first() {\n\t\treturn this.inner.a1;\n\t}\n}\n',
	"packages/app/src/index.ts":
		'export { settings as defaults } from "./config.js";\nexport * from "./factory.js";\n',
	"packages/app/src/consumer.ts":
		'import { defaults, Holder, make } from "./index.js";\n\nexport async function main() {\n\tconst current = defaults;\n\tconst { a1 } = new Holder(current).inner;\n\tconst plain = { a1: 3 };\n\treturn [current.a1, (await make()).a1, a1, plain.a1];\n}\n',
	"packages/cli/tsconfig.json": tsconfig,
	"packages/cli/src/main.ts":
		'import { defaults } from "../../app/src/index.js";\n\nexport const timeout = defaults.a1 * 1000;\n',
};

const handler = TypeScript.Project.promise(
	renameA1,
	async ({ payload, program, checker, references, edit }) => {
		const member = await findMember(program, checker, payload);
		if (member === undefined) return [];

		return (await references(member)).map((reference) =>
			edit.rename(reference.node, payload.to),
		);
	},
	{ include: ({ include }) => include },
);

layer(NodeFileSystem.layer)("TypeScript.Project", (it) => {
	it.effect("renames a field wherever a value of the type flows, across files and packages", () =>
		Effect.gen(function* () {
			const root = yield* fixture(files);

			expect(yield* outcomeOf(root, handler)).toEqual({
				_tag: "Completed",
				performer: "automated",
			});
			const after = yield* readFiles(root, Object.keys(files));
			expect(after["packages/app/src/config.ts"]).toContain("{ a2: 1, other");
			expect(after["packages/app/src/factory.ts"]).toContain("return this.inner.a2;");
			expect(after["packages/app/src/consumer.ts"]).toContain(
				"const { a2: a1 } = new Holder(current).inner;",
			);
			expect(after["packages/app/src/consumer.ts"]).toContain(
				"return [current.a2, (await make()).a2, a1, plain.a1];",
			);
			expect(after["packages/cli/src/main.ts"]).toContain("defaults.a2 * 1000");
			expect(after["node_modules/@acme/widgets/index.d.ts"]).toBe(
				files["node_modules/@acme/widgets/index.d.ts"],
			);
		}),
	);

	it.effect("runs once per project with that project's matched files", () =>
		Effect.gen(function* () {
			const seen: Array<readonly [TypeScript.Project.Info, ReadonlyArray<string>]> = [];
			const recording = TypeScript.Project.effect(
				renameA1,
				(context) => Effect.sync(() => (seen.push([context.project, context.files]), [])),
				{ include: ({ include }) => [...include, "scripts/*.ts"] },
			);
			const root = yield* fixture({
				...files,
				"scripts/loose.ts": "export const loose = 1;\n",
			});

			expect(yield* outcomeOf(root, recording)).toEqual({
				_tag: "Skipped",
				reason: "No matched file would change",
			});
			expect(
				seen.map(([project, paths]) => [
					project.kind === "configured" ? project.config : "inferred",
					paths,
				]),
			).toEqual([
				[
					"packages/app/tsconfig.json",
					[
						"packages/app/src/config.ts",
						"packages/app/src/consumer.ts",
						"packages/app/src/factory.ts",
						"packages/app/src/index.ts",
					],
				],
				["packages/cli/tsconfig.json", ["packages/cli/src/main.ts"]],
				["inferred", ["scripts/loose.ts"]],
			]);
		}),
	);

	it.effect("fails when a transform edits a file outside its project's matched files", () =>
		Effect.gen(function* () {
			const escaping = TypeScript.Project.promise(
				renameA1,
				async (context) =>
					context.files.includes("packages/cli/src/main.ts")
						? [
								{
									path: "packages/app/src/config.ts",
									pos: 0,
									end: 0,
									newText: "// cli\n",
								},
							]
						: [],
				{ include: ({ include }) => include },
			);
			const root = yield* fixture(files);
			const outcome = yield* outcomeOf(root, escaping);

			const error = transformFailed(outcome);
			expect(error.failures).toMatchObject([
				{
					project: { kind: "configured", config: "packages/cli/tsconfig.json" },
					cause: { _tag: "EditRejected" },
				},
			]);
			expect(yield* readFiles(root, Object.keys(files))).toEqual(files);
		}),
	);

	it.effect("reports a thrown error with its project", () =>
		Effect.gen(function* () {
			const throwing = TypeScript.Project.promise(
				renameA1,
				async ({ payload, program, checker }) => {
					await findMember(program, checker, { ...payload, from: "missing" });

					return [];
				},
				{
					include: ({ include }) => include,
					errors: [(cause: unknown) => cause instanceof MissingMember],
				},
			);
			const root = yield* fixture(files);
			const outcome = yield* outcomeOf(root, throwing);

			const error = transformFailed(outcome);
			expect(
				error.failures.map((failure) => [failure.project, failure.path, failure.cause]),
			).toEqual([
				[
					{ kind: "configured", config: "packages/app/tsconfig.json" },
					undefined,
					expect.any(MissingMember),
				],
				[
					{ kind: "configured", config: "packages/cli/tsconfig.json" },
					undefined,
					expect.any(MissingMember),
				],
			]);
		}),
	);
});
