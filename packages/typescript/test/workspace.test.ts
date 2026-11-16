import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { expect, layer } from "@effect/vitest";
import { Array as Arr, Deferred, Effect, Exit, Fiber, FileSystem, Order, Scope } from "effect";

import { TypeScript } from "@deltafold/typescript";
import { TypeScriptNode } from "@deltafold/typescript/node";
import { internals } from "../src/workspace.ts";
import { fixture, listFiles, readFiles } from "./__fixtures__/workspace.ts";

const withWorkspace = <A, E>(
	root: string,
	use: (workspace: TypeScript.Workspace) => Effect.Effect<A, E, Scope.Scope>,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			return yield* use(yield* TypeScript.Workspace);
		}),
	).pipe(
		// Each test builds a workspace for its own temporary root.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(TypeScriptNode.layer({ root })),
	);

layer(NodeFileSystem.layer)("TypeScript.Workspace", (it) => {
	it.effect("matches files under the root, sorted, never inside node_modules", () =>
		Effect.gen(function* () {
			const root = yield* fixture({
				"src/b.ts": "",
				"src/a.ts": "",
				"src/nested/c.ts": "",
				"node_modules/pkg/index.ts": "",
				"src/node_modules/pkg/index.ts": "",
			});
			const matched = yield* withWorkspace(root, (workspace) =>
				internals(workspace).match("test", ["**/*.ts"]),
			);

			expect(matched).toEqual(["src/a.ts", "src/b.ts", "src/nested/c.ts"]);
		}),
	);

	it.effect("refuses absolute patterns and patterns with parent segments", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "src/a.ts": "" });
			for (const pattern of ["/src/*.ts", "C:/src/*.ts", "src/../*.ts"]) {
				const exit = yield* withWorkspace(root, (workspace) =>
					internals(workspace).match("test", [pattern]),
				).pipe(Effect.exit);
				expect(exit).toMatchObject(
					Exit.fail({ _tag: "ReadFailed", reason: "pattern", path: pattern }),
				);
			}
		}),
	);

	it.effect("refuses symbolic links", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "src/a.ts": "export {};\n" });
			const fs = yield* FileSystem.FileSystem;
			const linked = yield* fs.symlink(`${root}/src/a.ts`, `${root}/src/link.ts`).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			// Creating links needs extra privileges on some Windows machines.
			if (!linked) return;

			const exit = yield* withWorkspace(root, (workspace) =>
				internals(workspace).match("test", ["src/*.ts"]),
			).pipe(Effect.exit);
			expect(exit).toMatchObject(
				Exit.fail({ _tag: "ReadFailed", reason: "link", path: "src/link.ts" }),
			);
		}),
	);

	it.effect("writes every file, keeping a byte order mark", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "a.ts": "\uFEFFa\r\n", "b.ts": "b\n" });
			yield* withWorkspace(root, (workspace) =>
				Effect.gen(function* () {
					const ws = internals(workspace);
					const a = yield* ws.read("test", "a.ts");
					expect(a).toBe("\uFEFFa\r\n");
					yield* ws.write("test", [
						{ path: "a.ts", expected: a, text: "\uFEFFA\r\n" },
						{ path: "b.ts", expected: "b\n", text: "B\n" },
					]);
				}),
			);

			expect(yield* readFiles(root, ["a.ts", "b.ts"])).toEqual({
				"a.ts": "\uFEFFA\r\n",
				"b.ts": "B\n",
			});
			expect(Arr.sort(yield* listFiles(root), Order.String)).toEqual(["a.ts", "b.ts"]);
		}),
	);

	it.effect("writes nothing when any file changed after it was read", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "a.ts": "a\n", "b.ts": "changed\n", "c.ts": "c\n" });
			const exit = yield* withWorkspace(root, (workspace) =>
				internals(workspace).write("rename", [
					{ path: "a.ts", expected: "a\n", text: "A\n" },
					{ path: "b.ts", expected: "b\n", text: "B\n" },
					{ path: "c.ts", expected: "c\n", text: "C\n" },
				]),
			).pipe(Effect.exit);

			expect(exit).toMatchObject(
				Exit.fail({
					_tag: "WriteFailed",
					actionId: "rename",
					writtenPaths: [],
					failed: {
						path: "b.ts",
						status: "not-written",
						reason: "The file changed after it was read",
					},
					pendingPaths: ["c.ts"],
				}),
			);
			expect(yield* readFiles(root, ["a.ts", "b.ts", "c.ts"])).toEqual({
				"a.ts": "a\n",
				"b.ts": "changed\n",
				"c.ts": "c\n",
			});
			expect(Arr.sort(yield* listFiles(root), Order.String)).toEqual([
				"a.ts",
				"b.ts",
				"c.ts",
			]);
		}),
	);

	it.effect("holds a file lock until its scope closes", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "a.ts": "" });
			yield* withWorkspace(root, (workspace) =>
				Effect.gen(function* () {
					const release = yield* Deferred.make<void>();
					const held = yield* Deferred.make<void>();
					const events: Array<string> = [];
					const first = yield* Effect.forkChild(
						Effect.scoped(
							Effect.gen(function* () {
								yield* workspace.lock(["a.ts", "A.ts"]);
								events.push("first locked");
								yield* Deferred.succeed(held, undefined);
								yield* Deferred.await(release);
								events.push("first released");
							}),
						),
					);
					yield* Deferred.await(held);
					const second = yield* Effect.forkChild(
						Effect.scoped(
							Effect.sync(() => events.push("second waiting")).pipe(
								Effect.andThen(workspace.lock(["a.ts"])),
								Effect.andThen(Effect.sync(() => events.push("second locked"))),
							),
						),
					);
					yield* Effect.yieldNow;
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(first);
					yield* Fiber.join(second);

					expect(events).toEqual([
						"first locked",
						"second waiting",
						"first released",
						"second locked",
					]);
				}),
			);
		}),
	);
});
