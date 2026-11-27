import { Effect, Result, Scope } from "effect";
import type { SourceFile } from "typescript-7.1/ast";
import type { Checker, Program } from "typescript-7.1/async";

import type { Action } from "deltafold";
import { Handler } from "deltafold";
import type { Edits, FileEdit, TextEdit } from "./edits.ts";
import type { NoServices, ResolvedServices, ServiceIds, Unit, UnitResult } from "./engine.ts";
import { apply, classify, prepare, resolveServices, runEffect, runPromise } from "./engine.ts";
import type { AdapterCause, Errors, Failure, GuardedError } from "./errors.ts";
import { EditRejected } from "./errors.ts";
import type { Info, Options, PromiseOptions } from "./project.ts";
import type { Workspace } from "./workspace.ts";

/** @since @next */
export type Context<Payload> = {
	readonly payload: Payload;
	/** Root-relative and `/`-separated. */
	readonly path: string;
	readonly sourceFile: SourceFile;
	readonly project: Info;
	readonly program: Program;
	readonly checker: Checker;
	/** Accepts nodes of this file only. */
	readonly edit: Edits;
};

/** @since @next */
export type PromiseContext<
	Payload,
	S extends Handler.ServiceMap = NoServices,
> = Context<Payload> & {
	/** Aborted when the action is interrupted. */
	readonly signal: AbortSignal;
	readonly services: ResolvedServices<S>;
};

const hasPath = (edit: TextEdit): edit is FileEdit =>
	"path" in edit && typeof edit.path === "string";

const checkFile = <C>(
	unit: Unit,
	path: string,
	edits: ReadonlyArray<TextEdit>,
): UnitResult<C | EditRejected> => {
	const outside = edits.filter(hasPath).find((edit) => edit.path !== path);
	if (outside !== undefined) {
		return {
			failures: [
				{
					project: unit.info,
					path,
					cause: new EditRejected({
						path,
						reason: `A file transform returned an edit for ${outside.path}`,
						ranges: [{ pos: outside.pos, end: outside.end }],
					}),
				},
			],
			edits: [],
		};
	}

	return {
		failures: [],
		edits: edits.map(({ pos, end, newText }) => ({ path, pos, end, newText })),
	};
};

const file = <A extends Action.Any, C, R>(
	action: A,
	options: Options<A["payload"]>,
	run: (
		unit: Unit,
		path: string,
		sourceFile: SourceFile,
	) => Effect.Effect<Result.Result<ReadonlyArray<TextEdit>, C | AdapterCause>, never, R>,
) =>
	Handler.effect(action, {
		prepare: (payload) =>
			prepare<C, R>(action, options.include(payload), (unit) =>
				Effect.gen(function* () {
					const failures: Array<Failure<C | AdapterCause>> = [];
					const edits: Array<FileEdit> = [];
					for (const [path, sourceFile] of unit.sources) {
						const result = yield* run(unit, path, sourceFile);
						if (Result.isFailure(result)) {
							failures.push({ project: unit.info, path, cause: result.failure });
							continue;
						}
						const checked = checkFile<C>(unit, path, result.success);
						failures.push(...checked.failures);
						edits.push(...checked.edits);
					}

					return { failures, edits };
				}),
			),
		apply: (pending) => apply(action.id, pending),
	});

const contextOf = <Payload>(
	unit: Unit,
	payload: Payload,
	path: string,
	sourceFile: SourceFile,
): Context<Payload> => ({
	payload,
	path,
	sourceFile,
	project: unit.info,
	program: unit.project.program,
	checker: unit.project.checker,
	edit: unit.edits([path]),
});

/**
 * Runs a transform once per matched file. The handler computes edits in its prepare
 * phase and writes them in its apply phase, so a dry run shows whether any file would
 * change.
 *
 * @example
 * ```ts
 * TypeScript.File.promise(
 * 	renameCreateClient,
 * 	async ({ sourceFile, edit }) => findImports(sourceFile).map((specifier) =>
 * 		edit.replace(specifier, "makeClient as createClient"),
 * 	),
 * 	{ include: ({ include }) => include },
 * );
 * ```
 *
 * @since @next
 */
export const promise = <
	A extends Action.Any,
	const S extends Handler.ServiceMap = NoServices,
	const G extends ReadonlyArray<Handler.ErrorGuard> = [],
>(
	action: A,
	transform: (
		context: PromiseContext<A["payload"], S>,
	) => PromiseLike<ReadonlyArray<TextEdit>> | ReadonlyArray<TextEdit>,
	options: PromiseOptions<A["payload"], S, G>,
): Handler.Handler<A, Errors<GuardedError<G[number]>>, Workspace | ServiceIds<S>> =>
	file<A, GuardedError<G[number]>, ServiceIds<S>>(action, options, (unit, path, sourceFile) =>
		Effect.flatMap(resolveServices(options.services), (services) =>
			runPromise(
				(signal) =>
					transform({
						...contextOf(unit, action.payload, path, sourceFile),
						signal,
						services,
					}),
				classify(action, options.errors ?? []),
			),
		),
	);

/**
 * Runs a transform once per matched file. A defect becomes
 * `Handler.UnexpectedHandlerError`.
 *
 * @since @next
 */
export const effect = <A extends Action.Any, E = never, R = never>(
	action: A,
	transform: (context: Context<A["payload"]>) => Effect.Effect<ReadonlyArray<TextEdit>, E, R>,
	options: Options<A["payload"]>,
): Handler.Handler<A, Errors<E>, Workspace | Exclude<R, Scope.Scope>> =>
	file<A, E, R>(action, options, (unit, path, sourceFile) =>
		runEffect(
			action,
			Effect.suspend(() => transform(contextOf(unit, action.payload, path, sourceFile))),
		),
	);
