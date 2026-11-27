import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, FileSystem, Layer, Path, Scope } from "effect";
import { API } from "typescript-7.1/async";

import * as Workspace from "../workspace.ts";

const jsoncSuffix = ".deltafold.json";

/**
 * Runs the TypeScript compiler bundled with this package as a child process. The
 * process starts on the first snapshot and stops when the layer's scope closes. It is
 * never restarted after a failure.
 *
 * TypeScript 7.1.0-beta finds no project for a `.jsonc` file. Each snapshot therefore
 * opens such a file under a hidden `.json` name beside it and serves its text from
 * memory, so nothing is written under that name. Each snapshot picks a name that is free
 * on disk and differs, ignoring case, from every opened file.
 */
const compiler = (
	cwd: string,
): Effect.Effect<Workspace.Compiler, never, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		let api: API | undefined;
		yield* Effect.addFinalizer(() => {
			const started = api;

			return started === undefined
				? Effect.void
				: Effect.ignore(Effect.promise(() => started.close()));
		});

		const allocate = (path: string, taken: Set<string>) =>
			Effect.gen(function* () {
				const slash = path.lastIndexOf("/");
				for (let attempt = 0; attempt < 16; attempt++) {
					const token = Math.random().toString(36).slice(2, 10);
					const candidate = `${path.slice(0, slash)}/.${path.slice(slash + 1)}.${token}${jsoncSuffix}`;
					if (taken.has(candidate.toLowerCase())) continue;
					// A name whose existence cannot be checked counts as taken.
					if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => true)))
						continue;
					taken.add(candidate.toLowerCase());

					return candidate;
				}

				return yield* new Workspace.CompilerUnavailable({
					cause: new Error(`Could not choose a compiler name for ${path}`),
				});
			});

		return {
			open: (files) =>
				Effect.gen(function* () {
					const taken = new Set(files.map((file) => file.path.toLowerCase()));
					const aliases = new Map<string, string>();
					for (const file of files) {
						if (/\.jsonc$/i.test(file.path))
							aliases.set(file.path, yield* allocate(file.path, taken));
					}
					const compilerPath = (path: string) => aliases.get(path) ?? path;
					const layered = Object.fromEntries(
						files.flatMap((file) => {
							const alias = aliases.get(file.path);

							return alias === undefined ? [] : [[alias, file.text]];
						}),
					);

					const snapshot = yield* Effect.acquireRelease(
						Effect.tryPromise({
							try: () => {
								api ??= new API({ cwd });

								return api.createSnapshot({
									openFiles: files.map((file) => compilerPath(file.path)),
									...(aliases.size === 0
										? {}
										: { fileSystem: { kind: "layer", files: layered } }),
								});
							},
							catch: (cause) => new Workspace.CompilerUnavailable({ cause }),
						}),
						(opened) => Effect.ignore(Effect.promise(() => opened.dispose())),
					);

					return { snapshot, compilerPath };
				}),
		};
	});

/**
 * Provides `TypeScript.Workspace` for a root directory, with Node's file system and
 * the TypeScript compiler. Payload globs match under `root`, and a relative `root`
 * resolves against the current working directory.
 *
 * @example
 * ```ts
 * await Executor.runPromise(plan, {
 * 	handlers: [renameClient],
 * 	services: TypeScriptNode.layer({ root: process.cwd() }),
 * });
 * ```
 *
 * @since @next
 */
export const layer = (options: { readonly root: string }): Layer.Layer<Workspace.Workspace> =>
	Layer.effect(
		Workspace.Workspace,
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const root = path.resolve(options.root);

			return yield* Workspace.make({ root, compiler: yield* compiler(root) });
		}),
	).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));
