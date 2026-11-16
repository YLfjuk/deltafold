// Real-file fixtures. The TypeScript compiler reads files from disk, so these tests
// write each fixture project into a temporary directory that the test's scope removes.
import { Effect, FileSystem, Result, Scope } from "effect";

import { TypeScript } from "@deltafold/typescript";
import { TypeScriptNode } from "@deltafold/typescript/node";
import { type Action, Executor, type Handler, History, Migration, Plan, Version } from "deltafold";

export type Files = Readonly<Record<string, string>>;

/** Writes `files` under a new temporary directory and returns its path. */
export const fixture = (
	files: Files,
): Effect.Effect<string, never, Scope.Scope | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const root = (yield* fs.makeTempDirectoryScoped({
			prefix: "deltafold-typescript-",
		})).replaceAll("\\", "/");
		yield* writeFiles(root, files);

		return root;
	}).pipe(Effect.orDie);

export const writeFiles = (root: string, files: Files) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		for (const [path, text] of Object.entries(files)) {
			const target = `${root}/${path}`;
			yield* fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true });
			yield* fs.writeFileString(target, text);
		}
	}).pipe(Effect.orDie);

/** Reads root-relative files. */
export const readFiles = (root: string, paths: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const entries: Array<[string, string]> = [];
		// Effect's readFileString drops a byte order mark; decode the bytes to keep it.
		const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
		for (const path of paths)
			entries.push([path, decoder.decode(yield* fs.readFile(`${root}/${path}`))]);

		return Object.fromEntries(entries);
	}).pipe(Effect.orDie);

/** Lists every file under `root`, including temporary files. */
export const listFiles = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		return (yield* fs.readDirectory(root, { recursive: true })).map((path) =>
			path.replaceAll("\\", "/"),
		);
	}).pipe(Effect.orDie);

const v1 = Version.make("1.0.0", { changes: [] });
const v2 = Version.make("2.0.0", { previous: v1, changes: [] });

/** A plan with one migration that runs `action`. */
export const planOf = <A extends Action.Any>(action: A) => {
	const history = History.make({
		versions: [v1, v2],
		migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${action}`],
	});
	const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
	if (Result.isFailure(resolved)) throw resolved.failure;

	return resolved.success;
};

/**
 * Runs one handler's action under `root` and returns its outcome. An execution failure
 * still carries the report.
 */
export const outcomeOf = <A extends Action.Any, E>(
	root: string,
	handler: Handler.Handler<A, E, TypeScript.Workspace>,
	options: { readonly dryRun?: boolean } = {},
) =>
	Effect.gen(function* () {
		// The helper is generic, so it checks coverage at run time.
		const result = yield* Executor.effect(Plan.withRuntimeCoverage(planOf(handler.action)), {
			handlers: [handler],
			dryRun: options.dryRun ?? false,
		}).pipe(
			// Each test builds a workspace for its own temporary root.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(TypeScriptNode.layer({ root })),
			Effect.result,
		);
		const report = Result.isSuccess(result)
			? result.success
			: "report" in result.failure
				? result.failure.report
				: undefined;
		if (report === undefined) return yield* Effect.die(result);

		return report.occurrences[0]!.outcome;
	});

/** The `TransformFailed` error of a failed outcome. */
export const transformFailed = <E>(outcome: Executor.Outcome<TypeScript.Errors<E>>) => {
	const error = outcome._tag === "Failed" ? outcome.error : undefined;
	if (!(error instanceof TypeScript.TransformFailed)) {
		throw new Error(`Expected a TransformFailed failure, got ${JSON.stringify(outcome)}`);
	}

	return error;
};
