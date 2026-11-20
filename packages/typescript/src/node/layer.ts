import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, Layer, Path, Scope } from "effect";
import { API } from "typescript-7.1/async";

import * as Workspace from "../workspace.ts";

const jsoncSuffix = ".deltafold.json";

/**
 * The name under which the compiler opens a file. TypeScript 7.1.0-beta finds no
 * project for a `.jsonc` file, so such a file is opened as a hidden `.json` file next
 * to it, whose text the snapshot supplies. Nothing is written under that name.
 */
const compilerPath = (path: string) => {
	if (!/\.jsonc$/i.test(path)) return path;
	const slash = path.lastIndexOf("/");

	return `${path.slice(0, slash)}/.${path.slice(slash + 1)}${jsoncSuffix}`;
};

/**
 * Runs the TypeScript compiler bundled with this package as a child process. The
 * process starts on the first snapshot and stops when the layer's scope closes. It is
 * never restarted after a failure.
 */
const compiler = (cwd: string): Effect.Effect<Workspace.Compiler, never, Scope.Scope> =>
	Effect.gen(function* () {
		let api: API | undefined;
		yield* Effect.addFinalizer(() =>
			api === undefined ? Effect.void : Effect.ignore(Effect.promise(() => api!.close())),
		);

		return {
			open: (files) => {
				const aliased = Object.fromEntries(
					files
						.filter((file) => compilerPath(file.path) !== file.path)
						.map((file) => [compilerPath(file.path), file.text]),
				);

				return Effect.acquireRelease(
					Effect.tryPromise({
						try: () => {
							api ??= new API({ cwd });

							return api.createSnapshot({
								openFiles: files.map((file) => compilerPath(file.path)),
								...(Object.keys(aliased).length === 0
									? {}
									: { fileSystem: { kind: "layer", files: aliased } }),
							});
						},
						catch: (cause) => new Workspace.CompilerUnavailable({ cause }),
					}),
					(snapshot) => Effect.ignore(Effect.promise(() => snapshot.dispose())),
				).pipe(Effect.map((snapshot) => ({ snapshot, compilerPath })));
			},
		};
	});

/**
 * Provides `TypeScript.Workspace` for a root directory, with Node's file system and
 * the TypeScript compiler. Payload globs are matched under `root`. A relative `root` is
 * resolved against the current working directory.
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
