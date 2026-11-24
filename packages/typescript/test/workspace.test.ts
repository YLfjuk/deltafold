import { symlink } from "node:fs/promises";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { expect, layer } from "@effect/vitest";
import {
	Array as Arr,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Order,
	PlatformError,
	Scope,
} from "effect";

import { TypeScript } from "@deltafold/typescript";
import { TypeScriptNode } from "@deltafold/typescript/node";
import { internals, make } from "../src/workspace.ts";
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

/**
 * Builds a workspace whose file system fails to rename onto `failing`. Write tests use
 * no compiler.
 */
const withFailingRename = <A, E>(
	root: string,
	failing: string,
	use: (workspace: TypeScript.Workspace) => Effect.Effect<A, E, Scope.Scope>,
) =>
	Effect.scoped(
		Effect.flatMap(
			make({ root, compiler: { open: () => Effect.die("The test opens no snapshot") } }),
			use,
		),
	).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				Layer.effect(
					FileSystem.FileSystem,
					Effect.map(FileSystem.FileSystem, (fs) => ({
						...fs,
						rename: (from: string, to: string) =>
							to.endsWith(`/${failing}`)
								? Effect.fail(
										PlatformError.systemError({
											_tag: "Busy",
											module: "FileSystem",
											method: "rename",
											pathOrDescriptor: to,
										}),
									)
								: fs.rename(from, to),
					})),
				),
				NodePath.layer,
			).pipe(Layer.provide(NodeFileSystem.layer)),
		),
	);

/**
 * Whether this machine lets the tests create file links. Windows refuses them without
 * extra privileges; any other failure fails the probe.
 */
const canLinkFiles = await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped({ prefix: "deltafold-link-" });
			yield* fs.writeFileString(`${directory}/target`, "");

			return yield* fs.symlink(`${directory}/target`, `${directory}/link`).pipe(
				Effect.as(true),
				Effect.catchIf(
					(error) => error.reason._tag === "PermissionDenied",
					() => Effect.succeed(false),
				),
			);
		}),
	).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(NodeFileSystem.layer),
	),
);

/** Lets forked fibers run until they block. */
const settle = Effect.gen(function* () {
	for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
});

/** Holds a lock in a forked scope until `release` runs. */
const holdLock = (workspace: TypeScript.Workspace, path: string) =>
	Effect.gen(function* () {
		const held = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		const holder = yield* Effect.forkChild(
			Effect.scoped(
				workspace
					.lock([path])
					.pipe(
						Effect.andThen(Deferred.succeed(held, undefined)),
						Effect.andThen(Deferred.await(release)),
					),
			),
		);
		yield* Deferred.await(held);

		return {
			release: Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(holder))),
		};
	});

/** Whether taking a lock is still waiting after other fibers have run. */
const stillWaiting = (lock: Effect.Effect<void, never, Scope.Scope>) =>
	Effect.gen(function* () {
		const attempt = yield* Effect.forkChild(Effect.scoped(lock));
		yield* settle;
		const waiting = attempt.pollUnsafe() === undefined;
		yield* Fiber.interrupt(attempt);

		return waiting;
	});

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

	it.effect("never matches the write step's temporary files", () =>
		Effect.gen(function* () {
			const root = yield* fixture({
				".a.ts.k3j2.deltafold-tmp": "",
				"src/.b.ts.x9.deltafold-tmp": "",
				".eslintrc.json": "{}",
			});
			const matched = yield* withWorkspace(root, (workspace) =>
				internals(workspace).match("test", [".*", "**/.*", "**/*"]),
			);

			expect(matched).toEqual([".eslintrc.json"]);
		}),
	);

	it.effect("matches patterns with `.` segments", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "src/a.ts": "", "b.ts": "" });
			const matched = yield* withWorkspace(root, (workspace) =>
				internals(workspace).match("test", ["./src/*.ts", "src/./*.ts"]),
			);

			expect(matched).toEqual(["src/a.ts"]);
		}),
	);

	it.effect("refuses patterns that are absolute or leave the root", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "src/a.ts": "" });
			for (const pattern of [
				"/src/*.ts",
				"\\src\\*.ts",
				"C:/src/*.ts",
				"C:src/*.ts",
				"C:../secret.ts",
				"../*.ts",
				"src/../*.ts",
				"src\\..\\..\\secret.ts",
				"**/../*.ts",
				"{../secret.ts,src/a.ts}",
				"src/{a,../..}/*.ts",
			]) {
				const exit = yield* withWorkspace(root, (workspace) =>
					internals(workspace).match("test", [pattern]),
				).pipe(Effect.exit);
				expect(exit).toMatchObject(
					Exit.fail({
						_tag: "@deltafold/typescript/ReadFailed",
						reason: "pattern",
						path: pattern,
					}),
				);
			}
		}),
	);

	it.effect.skipIf(!canLinkFiles)("refuses symbolic links", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "src/a.ts": "export {};\n" });
			const fs = yield* FileSystem.FileSystem;
			yield* fs.symlink(`${root}/src/a.ts`, `${root}/src/link.ts`).pipe(Effect.orDie);

			const exit = yield* withWorkspace(root, (workspace) =>
				internals(workspace).match("test", ["src/*.ts"]),
			).pipe(Effect.exit);
			// oxlint-disable-next-line vitest/no-standalone-expect -- it.effect.skipIf registers this test.
			expect(exit).toMatchObject(
				Exit.fail({
					_tag: "@deltafold/typescript/ReadFailed",
					reason: "link",
					path: "src/link.ts",
				}),
			);
		}),
	);

	it.effect("refuses files inside a linked directory", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "outside/a.ts": "export {};\n", "src/b.ts": "" });
			// A junction on Windows, which needs no extra privileges; a directory link elsewhere.
			yield* Effect.promise(() =>
				symlink(`${root}/outside`, `${root}/src/linked`, "junction"),
			);

			const exit = yield* withWorkspace(root, (workspace) =>
				internals(workspace).match("test", ["src/linked/*.ts"]),
			).pipe(Effect.exit);
			expect(exit).toMatchObject(
				Exit.fail({
					_tag: "@deltafold/typescript/ReadFailed",
					reason: "link",
					path: "src/linked/a.ts",
				}),
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
					_tag: "@deltafold/typescript/WriteFailed",
					actionId: "rename",
					writtenPaths: [],
					failed: {
						path: "b.ts",
						status: "not-written",
						reason: "The file changed after it was read",
					},
					pendingPaths: ["a.ts", "c.ts"],
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

	it.effect("reports written, failed, and pending files when a rename fails", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n" });
			const exit = yield* withFailingRename(root, "b.ts", (workspace) =>
				internals(workspace).write("rename", [
					{ path: "a.ts", expected: "a\n", text: "A\n" },
					{ path: "b.ts", expected: "b\n", text: "B\n" },
					{ path: "c.ts", expected: "c\n", text: "C\n" },
				]),
			).pipe(Effect.exit);

			expect(exit).toMatchObject(
				Exit.fail({
					_tag: "@deltafold/typescript/WriteFailed",
					actionId: "rename",
					writtenPaths: ["a.ts"],
					failed: { path: "b.ts", status: "unknown" },
					pendingPaths: ["c.ts"],
				}),
			);
			// Nothing is rolled back, and no temporary file is left.
			expect(yield* readFiles(root, ["a.ts", "b.ts", "c.ts"])).toEqual({
				"a.ts": "A\n",
				"b.ts": "b\n",
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

	it.effect("gives aliases of one path the same lock", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "src/a.ts": "" });
			yield* withWorkspace(root, (workspace) =>
				Effect.gen(function* () {
					const { release } = yield* holdLock(workspace, "src/a.ts");
					for (const alias of ["./src/a.ts", "src/./a.ts", "src/../src/a.ts"]) {
						expect({
							alias,
							waiting: yield* stillWaiting(workspace.lock([alias])),
						}).toEqual({
							alias,
							waiting: true,
						});
					}
					yield* release;
				}),
			);
		}),
	);

	it.effect("lets a fiber waiting for a lock be interrupted while another scope holds it", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "a.ts": "" });
			yield* withWorkspace(root, (workspace) =>
				Effect.gen(function* () {
					const { release } = yield* holdLock(workspace, "a.ts");
					const waiter = yield* Effect.forkChild(Effect.scoped(workspace.lock(["a.ts"])));
					yield* settle;

					// Interrupting the waiter finishes while the holder still has the lock.
					yield* Fiber.interrupt(waiter);
					expect(yield* stillWaiting(workspace.lock(["a.ts"]))).toBe(true);

					// The interrupted waiter took no permit: the lock is free once released.
					yield* release;
					expect(yield* stillWaiting(workspace.lock(["a.ts"]))).toBe(false);
				}),
			);
		}),
	);

	it.effect("takes locks in sorted order whatever order the paths are given in", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "a.ts": "", "b.ts": "" });
			yield* withWorkspace(root, (workspace) =>
				Effect.gen(function* () {
					const { release } = yield* holdLock(workspace, "a.ts");
					const waiter = yield* Effect.forkChild(
						Effect.scoped(workspace.lock(["b.ts", "a.ts"])),
					);
					yield* settle;

					// The waiter waits for a.ts before it takes b.ts.
					expect(yield* stillWaiting(workspace.lock(["b.ts"]))).toBe(false);
					yield* Fiber.interrupt(waiter);
					yield* release;
				}),
			);
		}),
	);

	it.effect("takes one lock for aliases of a path in one call", () =>
		Effect.gen(function* () {
			const root = yield* fixture({ "a.ts": "" });
			yield* withWorkspace(root, (workspace) =>
				Effect.gen(function* () {
					expect(yield* stillWaiting(workspace.lock(["a.ts", "./a.ts"]))).toBe(false);
				}),
			);
		}),
	);
});
