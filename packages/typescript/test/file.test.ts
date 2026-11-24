import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { expect, expectTypeOf, layer, vi } from "@effect/vitest";
import { Array as Arr, Context, Effect, Order, Schema, Scope } from "effect";
import { type Node, type SourceFile, SyntaxKind } from "typescript-7.1/ast";
import {
	isImportDeclaration,
	isNamedImports,
	isPropertyAssignment,
	isStringLiteral,
} from "typescript-7.1/ast/is";

import { TypeScript } from "@deltafold/typescript";
import { Action, type Handler } from "deltafold";
import { nameForm } from "../src/edits.ts";
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

/** The nodes named `name` under `node`: identifiers and string literals. */
const namesCalled = (node: Node, name: string): Array<Node> => {
	const found: Array<Node> = [];
	const visit = (child: Node): void => {
		if (
			(child.kind === SyntaxKind.Identifier || child.kind === SyntaxKind.StringLiteral) &&
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Identifiers and string literals have text.
			(child as Node & { readonly text: string }).text === name
		) {
			found.push(child);
		}
		child.forEachChild(visit);
	};
	visit(node);

	return found;
};

/** Renames every name `a1` whose form is one of `forms` to `a2`. */
const renameA1In = (forms: ReadonlyArray<TypeScript.NameForm>) =>
	TypeScript.File.promise(
		renameCreateClient,
		async ({ sourceFile, edit }) =>
			namesCalled(sourceFile, "a1")
				.filter((name) => forms.includes(nameForm(name)))
				.map((name) => edit.rename(name, "a2")),
		{ include: () => ["src/*.ts"] },
	);

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
			const visited: Array<string> = [];
			const recording = TypeScript.File.promise(
				renameCreateClient,
				async ({ path, sourceFile, edit, payload }) => {
					visited.push(path);

					return renameImports(sourceFile, edit, payload);
				},
				{ include: ({ include }) => include },
			);
			const outcome = yield* outcomeOf(root, recording);

			expect(visited).not.toContain("src/broken.ts");
			expect(Arr.sort(visited, Order.String)).toEqual([
				"src/aliased.tsx",
				"src/esm.ts",
				"src/unrelated.ts",
			]);
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
				["src/unrelated.ts", "UnexpectedHandlerError"],
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

	it.effect("refuses JSON that keeps only a comma in an emptied object", () =>
		Effect.gen(function* () {
			const config = '{"timeout": 1000,}\n';
			const root = yield* fixture({ "config.json": config });
			const emptying = TypeScript.File.promise(
				renameTimeout,
				async ({ sourceFile, edit, payload }) =>
					jsonKeys(sourceFile, payload.from).map((key) => edit.remove(key.parent)),
				{ include: () => ["*.json"] },
			);
			const outcome = yield* outcomeOf(root, emptying);

			expect(transformFailed(outcome).failures.map((failure) => failure.cause._tag)).toEqual([
				"EditRejected",
			]);
			expect(yield* readFiles(root, ["config.json"])).toEqual({ "config.json": config });
		}),
	);

	it.effect("opens a .jsonc file under a name that no matched file has", () =>
		Effect.gen(function* () {
			// A real file whose name looks like a hidden alias of config.jsonc.
			const jsonFiles = {
				"config.jsonc": '{\n\t// c\n\t"timeout": 1,\n}\n',
				".config.jsonc.deltafold.json": '{ "timeout": 2 }\n',
			};
			const renamed = {
				"config.jsonc": '{\n\t// c\n\t"requestTimeout": 1,\n}\n',
				".config.jsonc.deltafold.json": '{ "requestTimeout": 2 }\n',
			};
			const root = yield* fixture(jsonFiles);
			const rename = TypeScript.File.promise(
				renameTimeout,
				async ({ sourceFile, edit, payload }) =>
					jsonKeys(sourceFile, payload.from).map((key) => edit.rename(key, payload.to)),
				{ include: () => ["*.jsonc", ".*.json"] },
			);

			expect(yield* outcomeOf(root, rename)).toEqual({
				_tag: "Completed",
				performer: "automated",
			});
			expect(yield* readFiles(root, Object.keys(jsonFiles))).toEqual(renamed);
		}),
	);

	it.effect("keeps a .jsonc file and a real file with the same text apart in a project", () =>
		Effect.gen(function* () {
			const text = '{ "timeout": 1 }\n';
			const jsonFiles = { "config.jsonc": text, ".config.jsonc.deltafold.json": text };
			const root = yield* fixture(jsonFiles);
			const rename = TypeScript.Project.promise(
				renameTimeout,
				async (context) => {
					const edits: Array<TypeScript.FileEdit> = [];
					for (const path of context.files) {
						const sourceFile = await context.sourceFile(path);
						for (const key of jsonKeys(sourceFile, context.payload.from)) {
							edits.push(context.edit.rename(key, context.payload.to));
						}
					}

					return edits;
				},
				{ include: () => ["*.jsonc", ".*.json"] },
			);

			expect(yield* outcomeOf(root, rename)).toEqual({
				_tag: "Completed",
				performer: "automated",
			});
			expect(yield* readFiles(root, Object.keys(jsonFiles))).toEqual({
				"config.jsonc": '{ "requestTimeout": 1 }\n',
				".config.jsonc.deltafold.json": '{ "requestTimeout": 1 }\n',
			});
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

	it.effect("refuses edits for another file, returned or built from its nodes", () =>
		Effect.gen(function* () {
			const sources = {
				"tsconfig.json": tsconfig,
				"src/a.ts": "export const a = 1;\n",
				"src/b.ts": "export const b = 2;\n",
			};
			const root = yield* fixture(sources);
			const returning = TypeScript.File.promise(
				renameCreateClient,
				async ({ path }) =>
					path === "src/a.ts"
						? [{ path: "src/b.ts", pos: 0, end: 0, newText: "// a\n" }]
						: [],
				{ include: () => ["src/*.ts"] },
			);
			const building = TypeScript.File.effect(
				renameCreateClient,
				({ path, program, edit }) =>
					Effect.gen(function* () {
						if (path !== "src/a.ts") return [];
						// The compiler names files by their real path, which can differ from the
						// fixture's temporary path, such as a Windows short name.
						const other = yield* Effect.promise(async () => {
							const names = await program.getSourceFileNames();
							const name = names.find((file) => String(file).endsWith("/src/b.ts"));

							return name === undefined ? undefined : program.getSourceFile(name);
						});
						if (other === undefined)
							return yield* Effect.die("src/b.ts is not in the program");

						return [edit.replace(other.statements[0]!, "export const b = 3;")];
					}),
				{ include: () => ["src/*.ts"] },
			);

			for (const escaping of [returning, building]) {
				const { failures } = transformFailed(yield* outcomeOf(root, escaping));
				expect(failures.map((failure) => [failure.path, failure.cause._tag])).toEqual([
					["src/a.ts", "EditRejected"],
				]);
			}
			expect(yield* readFiles(root, Object.keys(sources))).toEqual(sources);
		}),
	);

	it.effect("renames shorthand properties and element access keys, and refuses other names", () =>
		Effect.gen(function* () {
			const source =
				'const a1 = 1;\nexport const short = { a1 };\ndeclare const record: Record<string, number>;\nexport const read = record["a1"];\n';
			const root = yield* fixture({ "tsconfig.json": tsconfig, "src/forms.ts": source });
			const { failures } = transformFailed(yield* outcomeOf(root, renameA1In(["other"])));
			expect(failures.map((failure) => [failure.path, failure.cause._tag])).toEqual([
				["src/forms.ts", "EditRejected"],
			]);
			expect(yield* readFiles(root, ["src/forms.ts"])).toEqual({ "src/forms.ts": source });

			expect(
				yield* outcomeOf(root, renameA1In(["shorthand-property", "element-access"])),
			).toEqual({ _tag: "Completed", performer: "automated" });
			expect(yield* readFiles(root, ["src/forms.ts"])).toEqual({
				"src/forms.ts":
					'const a1 = 1;\nexport const short = { a2: a1 };\ndeclare const record: Record<string, number>;\nexport const read = record["a2"];\n',
			});
		}),
	);

	it.effect("fails JSON and JSON with comments that do not parse", () =>
		Effect.gen(function* () {
			const broken = {
				"config.json": '{ "timeout": }\n',
				"settings.jsonc": '{\n\t// c\n\t"timeout": ,\n}\n',
			};
			const root = yield* fixture(broken);
			const rename = TypeScript.File.promise(
				renameTimeout,
				async ({ sourceFile, edit, payload }) =>
					jsonKeys(sourceFile, payload.from).map((key) => edit.rename(key, payload.to)),
				{ include: () => ["*.json", "*.jsonc"] },
			);

			const { failures } = transformFailed(yield* outcomeOf(root, rename));
			expect(failures.map((failure) => [failure.path, failure.cause._tag])).toEqual([
				["config.json", "SyntaxErrors"],
				["settings.jsonc", "SyntaxErrors"],
			]);
			expect(yield* readFiles(root, Object.keys(broken))).toEqual(broken);
		}),
	);

	it.effect("tries another hidden name for a .jsonc file while one is taken", () =>
		Effect.gen(function* () {
			// Math.random() returning 0.5 gives the token "i".
			const jsonFiles = {
				"config.jsonc": '{\n\t// c\n\t"timeout": 1,\n}\n',
				".config.jsonc.i.deltafold.json": '{ "timeout": 2 }\n',
			};
			const root = yield* fixture(jsonFiles);
			const rename = TypeScript.File.promise(
				renameTimeout,
				async ({ sourceFile, edit, payload }) =>
					jsonKeys(sourceFile, payload.from).map((key) => edit.rename(key, payload.to)),
				{ include: () => ["*.jsonc"] },
			);

			const random = vi.spyOn(Math, "random");
			try {
				random.mockReturnValue(0.5);
				const exhausted = yield* outcomeOf(root, rename);
				expect(exhausted).toMatchObject({
					_tag: "Failed",
					error: { _tag: "CompilerFailed", stage: "snapshot" },
				});
				expect(random).toHaveBeenCalledTimes(16);
				expect(yield* readFiles(root, Object.keys(jsonFiles))).toEqual(jsonFiles);

				random.mockReset();
				random.mockReturnValueOnce(0.5).mockReturnValueOnce(0.25);
				expect(yield* outcomeOf(root, rename)).toEqual({
					_tag: "Completed",
					performer: "automated",
				});
			} finally {
				random.mockRestore();
			}
			expect(yield* readFiles(root, Object.keys(jsonFiles))).toEqual({
				...jsonFiles,
				"config.jsonc": '{\n\t// c\n\t"requestTimeout": 1,\n}\n',
			});
			expect(Arr.sort(yield* listFiles(root), Order.String)).toEqual(
				Arr.sort(Object.keys(jsonFiles), Order.String),
			);
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

			class Missing extends Error {
				readonly missing = true;
			}
			const isMissing = (cause: unknown): cause is Missing => cause instanceof Missing;
			const guarded = TypeScript.File.promise(renameCreateClient, async () => [], {
				include: ({ include }) => include,
				errors: [isMissing],
			});
			expectTypeOf(guarded).toEqualTypeOf<
				Handler.Handler<
					typeof renameCreateClient,
					TypeScript.Errors<Missing>,
					TypeScript.Workspace
				>
			>();
			expectTypeOf(
				TypeScript.causes(
					new TypeScript.TransformFailed<Missing>({
						actionId: "a",
						root: "/",
						failures: [],
					}),
					isMissing,
				),
			).toEqualTypeOf<ReadonlyArray<TypeScript.Failure<Missing>>>();

			const scoped = Effect.gen(function* () {
				yield* Scope.Scope;
				yield* Clock;

				return yield* new NotFound();
			});
			expectTypeOf(
				TypeScript.File.effect(renameCreateClient, () => scoped, {
					include: ({ include }) => include,
				}),
			).toEqualTypeOf<
				Handler.Handler<
					typeof renameCreateClient,
					TypeScript.Errors<NotFound>,
					TypeScript.Workspace | Context.Service.Identifier<typeof Clock>
				>
			>();
			expectTypeOf(
				TypeScript.Project.effect(renameCreateClient, () => scoped, {
					include: ({ include }) => include,
				}),
			).toEqualTypeOf<
				Handler.Handler<
					typeof renameCreateClient,
					TypeScript.Errors<NotFound>,
					TypeScript.Workspace | Context.Service.Identifier<typeof Clock>
				>
			>();
		}),
	);
});
