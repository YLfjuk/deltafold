import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { expect, expectTypeOf, layer } from "@effect/vitest";
import { Context, Effect, Schema } from "effect";
import { type Node, type SourceFile, SyntaxKind } from "typescript-7.1/ast";
import {
	isImportDeclaration,
	isNamedImports,
	isPropertyAssignment,
	isStringLiteral,
} from "typescript-7.1/ast/is";

import { TypeScript } from "@deltafold/typescript";
import { Action, type Handler } from "deltafold";
import {
	fixture,
	listFiles,
	outcomeOf,
	readFiles,
	transformFailed,
} from "./__fixtures__/workspace.ts";

type RenameImport = {
	readonly module: string;
	readonly from: string;
	readonly to: string;
	readonly include: ReadonlyArray<string>;
};
const RenameImport = Action.define<RenameImport>("ts.rename-import");

const renameCreateClient = RenameImport.make("rename-create-client", {
	module: "@acme/widgets",
	from: "createClient",
	to: "makeClient",
	include: ["**/*.ts", "**/*.tsx"],
});

/** Aliases the old import name to the new export: `import { makeClient as createClient }`. */
const renameImports = (
	sourceFile: SourceFile,
	edit: TypeScript.Edits,
	{ module, from, to }: RenameImport,
): ReadonlyArray<TypeScript.TextEdit> =>
	sourceFile.statements.flatMap((statement) => {
		if (!isImportDeclaration(statement)) return [];
		if (
			!isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== module
		) {
			return [];
		}
		const bindings = statement.importClause?.namedBindings;
		if (bindings === undefined || !isNamedImports(bindings)) return [];

		return bindings.elements.flatMap((element) => {
			const imported = element.propertyName ?? element.name;
			if (imported.kind !== SyntaxKind.Identifier || imported.text !== from) return [];

			return element.propertyName === undefined
				? [edit.replace(element, `${to} as ${element.name.text}`)]
				: [edit.replace(element.propertyName, to)];
		});
	});

const tsconfig = JSON.stringify({ compilerOptions: { strict: true, jsx: 1 }, include: ["src"] });
const widgets = {
	"node_modules/@acme/widgets/package.json": JSON.stringify({
		name: "@acme/widgets",
		types: "index.d.ts",
	}),
	"node_modules/@acme/widgets/index.d.ts": "export declare function createClient(): unknown;\n",
};

const files = {
	"tsconfig.json": tsconfig,
	...widgets,
	"src/esm.ts":
		'import { createClient } from "@acme/widgets";\nexport const client = createClient();\n',
	"src/aliased.tsx":
		'﻿import { createClient as make } from "@acme/widgets";\r\n// café\r\nexport const View = () => <div>{String(make)}</div>;\r\n',
	"src/unrelated.ts":
		'import { createClient } from "redis";\nexport const other = createClient;\n',
};

type RenameKey = { readonly from: string; readonly to: string };
const RenameKey = Action.define<RenameKey>("json.rename-key");
const renameTimeout = RenameKey.make("rename-timeout", { from: "timeout", to: "requestTimeout" });

/** The string-literal names of JSON properties called `name`. */
const jsonKeys = (node: Node, name: string): Array<Node> => {
	const found: Array<Node> = [];
	const visit = (child: Node): void => {
		if (
			isPropertyAssignment(child) &&
			isStringLiteral(child.name) &&
			child.name.text === name
		) {
			found.push(child.name);
		}
		child.forEachChild(visit);
	};
	visit(node);

	return found;
};

const handler = TypeScript.File.promise(
	renameCreateClient,
	async ({ sourceFile, edit, payload }) => renameImports(sourceFile, edit, payload),
	{ include: ({ include }) => include },
);

layer(NodeFileSystem.layer)("TypeScript.File", (it) => {
	it.effect("rewrites every matched file and keeps byte order marks and line endings", () =>
		Effect.gen(function* () {
			const root = yield* fixture(files);
			const outcome = yield* outcomeOf(root, handler);

			expect(outcome).toEqual({ _tag: "Completed", performer: "automated" });
			expect(yield* readFiles(root, Object.keys(files))).toEqual({
				...files,
				"src/esm.ts":
					'import { makeClient as createClient } from "@acme/widgets";\nexport const client = createClient();\n',
				"src/aliased.tsx":
					'﻿import { makeClient as make } from "@acme/widgets";\r\n// café\r\nexport const View = () => <div>{String(make)}</div>;\r\n',
			});
			expect(
				(yield* listFiles(root)).filter((path) => path.endsWith(".deltafold-tmp")),
			).toEqual([]);
		}),
	);

	it.effect("skips when no matched file would change, so a second run is a no-op", () =>
		Effect.gen(function* () {
			const root = yield* fixture(files);
			yield* outcomeOf(root, handler);

			expect(yield* outcomeOf(root, handler)).toEqual({
				_tag: "Skipped",
				reason: "No matched file would change",
			});
		}),
	);

	it.effect("computes edits in a dry run without writing", () =>
		Effect.gen(function* () {
			const root = yield* fixture(files);

			expect(yield* outcomeOf(root, handler, { dryRun: true })).toEqual({
				_tag: "WouldExecute",
				evaluated: true,
				performer: "automated",
			});
			expect(yield* readFiles(root, Object.keys(files))).toEqual(files);
		}),
	);

	it.effect("skips when no file matches", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "tsconfig.json": tsconfig, ...widgets });

			expect(yield* outcomeOf(root, handler)).toEqual({
				_tag: "Skipped",
				reason: "No files match the include patterns",
			});
		}),
	);

	it.effect("fails files with syntax errors and writes nothing", () =>
		Effect.gen(function* () {
			const broken = {
				...files,
				"src/broken.ts": 'import { createClient } from "@acme/widgets";\nconst = ;\n',
			};
			const root = yield* fixture(broken);
			const outcome = yield* outcomeOf(root, handler);

			expect(outcome._tag).toBe("Failed");
			const { failures } = transformFailed(outcome);
			expect(failures.map((failure) => [failure.path, failure.cause._tag])).toEqual([
				["src/broken.ts", "SyntaxErrors"],
			]);
			expect(failures[0]!.project).toEqual({ kind: "configured", config: "tsconfig.json" });
			expect(yield* readFiles(root, Object.keys(broken))).toEqual(broken);
		}),
	);

	it.effect("collects every failure and keeps declared errors", () =>
		Effect.gen(function* () {
			class Unsupported extends Schema.TaggedError<
				Unsupported,
				{ readonly brand: unique symbol }
			>()("Unsupported", {
				file: Schema.String,
			}) {}
			const failing = TypeScript.File.promise(
				renameCreateClient,
				async ({ path }) => {
					if (path.endsWith(".tsx")) throw new Unsupported({ file: path });
					if (path.endsWith("unrelated.ts")) throw new Error("boom");

					return [];
				},
				{ include: ({ include }) => include, errors: [Unsupported] },
			);
			const root = yield* fixture(files);
			const outcome = yield* outcomeOf(root, failing);

			const failed = transformFailed(outcome);
			expect(failed.failures.map((failure) => [failure.path, failure.cause._tag])).toEqual([
				["src/aliased.tsx", "Unsupported"],
				["src/unrelated.ts", "UnknownError"],
			]);
			expect(
				TypeScript.causes(failed, Unsupported).map((failure) => failure.cause.file),
			).toEqual(["src/aliased.tsx"]);
		}),
	);

	it.effect("rejects overlapping edits", () =>
		Effect.gen(function* () {
			const overlapping = TypeScript.File.effect(
				renameCreateClient,
				({ sourceFile, edit }) =>
					Effect.succeed(
						sourceFile.statements.length === 0
							? []
							: [
									edit.replace(sourceFile.statements[0]!, "a"),
									edit.insertAfter(sourceFile.statements[0]!, "b"),
									{ pos: 1, end: 3, newText: "c" },
								],
					),
				{ include: () => ["src/esm.ts"] },
			);
			const root = yield* fixture(files);
			const outcome = yield* outcomeOf(root, overlapping);

			const error = transformFailed(outcome);
			expect(error.failures.map((failure) => failure.cause._tag)).toEqual(["EditRejected"]);
		}),
	);

	it.effect("refuses patterns that leave the root", () =>
		Effect.gen(function* () {
			const escaping = TypeScript.File.promise(renameCreateClient, async () => [], {
				include: () => ["../**/*.ts"],
			});
			const root = yield* fixture(files);
			const outcome = yield* outcomeOf(root, escaping);

			expect(outcome._tag === "Failed" ? outcome.error : undefined).toMatchObject({
				_tag: "ReadFailed",
				reason: "pattern",
				path: "../**/*.ts",
			});
		}),
	);

	it.effect("edits JSON with comments and refuses edits that break it", () =>
		Effect.gen(function* () {
			const config = '{\n\t// Milliseconds.\n\t"timeout": 1000,\n\t"retries": 2,\n}\n';
			const root = yield* fixture({ "widgets.config.json": config });

			const rename = TypeScript.File.promise(
				renameTimeout,
				async ({ sourceFile, edit, payload }) =>
					jsonKeys(sourceFile, payload.from).map((key) => edit.rename(key, payload.to)),
				{ include: () => ["*.json"] },
			);
			expect(yield* outcomeOf(root, rename)).toEqual({
				_tag: "Completed",
				performer: "automated",
			});
			expect(yield* readFiles(root, ["widgets.config.json"])).toEqual({
				"widgets.config.json":
					'{\n\t// Milliseconds.\n\t"requestTimeout": 1000,\n\t"retries": 2,\n}\n',
			});

			const breaking = TypeScript.File.promise(
				renameTimeout,
				async ({ sourceFile, edit, payload }) =>
					jsonKeys(sourceFile, payload.to).map((key) => edit.insertAfter(key, ",,")),
				{ include: () => ["*.json"] },
			);
			const outcome = yield* outcomeOf(root, breaking);
			const error = transformFailed(outcome);
			expect(error.failures.map((failure) => failure.cause._tag)).toEqual(["EditRejected"]);
		}),
	);

	it.effect("edits .jsonc files", () =>
		Effect.gen(function* () {
			const config = '{\n\t// Milliseconds.\n\t"timeout": 1000,\n}\n';
			const root = yield* fixture({ "config.jsonc": config });
			const rename = TypeScript.File.promise(
				renameTimeout,
				async ({ sourceFile, edit, project, payload }) => {
					expect(project.kind).toBe("inferred");

					return jsonKeys(sourceFile, payload.from).map((key) =>
						edit.rename(key, payload.to),
					);
				},
				{ include: () => ["*.jsonc"] },
			);

			expect(yield* outcomeOf(root, rename)).toEqual({
				_tag: "Completed",
				performer: "automated",
			});
			expect(yield* readFiles(root, ["config.jsonc"])).toEqual({
				"config.jsonc": '{\n\t// Milliseconds.\n\t"requestTimeout": 1000,\n}\n',
			});
			expect(yield* listFiles(root)).toEqual(["config.jsonc"]);
		}),
	);

	it.effect("refuses JSON whose tokens only a removed comment separated", () =>
		Effect.gen(function* () {
			const config = '{\n\t"timeout": 1000,\n}\n';
			const root = yield* fixture({ "config.json": config });
			const joining = TypeScript.File.promise(
				renameTimeout,
				async ({ sourceFile, edit, payload }) =>
					jsonKeys(sourceFile, payload.from).map((key) =>
						edit.insertAfter(key.parent, "/* c */2"),
					),
				{ include: () => ["*.json"] },
			);
			const outcome = yield* outcomeOf(root, joining);

			expect(transformFailed(outcome).failures.map((failure) => failure.cause._tag)).toEqual([
				"EditRejected",
			]);
			expect(yield* readFiles(root, ["config.json"])).toEqual({ "config.json": config });
		}),
	);

	it.effect("types the handler from its options", () =>
		Effect.sync(() => {
			class NotFound extends Schema.TaggedError<
				NotFound,
				{ readonly brand: unique symbol }
			>()("NotFound", {}) {}
			const Clock = Context.Service<{ readonly now: () => number }>("test/Clock");
			const typed = TypeScript.File.promise(
				renameCreateClient,
				async ({ services }) => (services.clock.now(), []),
				{
					include: ({ include }) => include,
					services: { clock: Clock },
					errors: [NotFound],
				},
			);

			expectTypeOf(handler).toEqualTypeOf<
				Handler.Handler<
					typeof renameCreateClient,
					TypeScript.Errors<never>,
					TypeScript.Workspace
				>
			>();
			expectTypeOf(typed).toEqualTypeOf<
				Handler.Handler<
					typeof renameCreateClient,
					TypeScript.Errors<NotFound>,
					TypeScript.Workspace | Context.Service.Identifier<typeof Clock>
				>
			>();
		}),
	);
});
