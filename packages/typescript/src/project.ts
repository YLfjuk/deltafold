import { Effect, Result, Scope } from "effect";
import type { Node, SourceFile } from "typescript-7.1/ast";
import { skipTrivia } from "typescript-7.1/ast/scanner";
import type { Checker, Program, Symbol } from "typescript-7.1/async";

import { type Action, Handler } from "deltafold";
import { type Edits, type FileEdit, nameForm, type NameForm } from "./edits.ts";
import {
	apply,
	classify,
	type NoServices,
	prepare,
	resolveServices,
	type ResolvedServices,
	runEffect,
	runPromise,
	type ServiceIds,
	type Unit,
	type UnitResult,
} from "./engine.ts";
import {
	type AdapterCause,
	EditRejected,
	type Errors,
	type Failure,
	type GuardedError,
	UnknownError,
} from "./errors.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The compiler project that a transform received: a configured project with the path of
 * its tsconfig file, relative to the root when it is under the root, or an inferred
 * project for files outside every tsconfig file.
 *
 * @since @next
 */
export type Info =
	| { readonly kind: "configured"; readonly config: string }
	| { readonly kind: "inferred"; readonly id: string };

/**
 * One use of a symbol in a file the transform may edit.
 *
 * @since @next
 */
export type Reference = {
	/** The root-relative, `/`-separated path of the file. */
	readonly path: string;
	/** The name node, such as the `a1` in `value.a1`. */
	readonly node: Node;
	/** Where the name appears. */
	readonly form: NameForm;
};

/**
 * What a project transform receives, besides `signal` and `services` for Promise
 * transforms.
 *
 * @since @next
 */
export type Context<Payload> = {
	readonly payload: Payload;
	readonly project: Info;
	/**
	 * The project's matched files, as root-relative paths. They are the only files the
	 * transform may edit. Files with syntax errors stop the transform from running.
	 */
	readonly files: ReadonlyArray<string>;
	/** The project's program. It reads every file of the project, including installed declarations. */
	readonly program: Program;
	readonly checker: Checker;
	readonly edit: Edits;
};

/**
 * What a Promise project transform receives.
 *
 * @since @next
 */
export type PromiseContext<
	Payload,
	S extends Handler.ServiceMap = NoServices,
> = Context<Payload> & {
	/** Loads one of `files`. */
	readonly sourceFile: (path: string) => Promise<SourceFile>;
	/**
	 * Finds the uses of a symbol with the compiler's find-references, limited to `files`.
	 * Uses in installed packages, unmatched files, and other projects' files are left out.
	 */
	readonly references: (symbol: Symbol) => Promise<ReadonlyArray<Reference>>;
	/** Aborted when the action is interrupted. */
	readonly signal: AbortSignal;
	readonly services: ResolvedServices<S>;
};

/**
 * What an Effect project transform receives.
 *
 * @since @next
 */
export type EffectContext<Payload> = Context<Payload> & {
	/** Loads one of `files`. */
	readonly sourceFile: (path: string) => Effect.Effect<SourceFile, UnknownError>;
	/**
	 * Finds the uses of a symbol with the compiler's find-references, limited to `files`.
	 * Uses in installed packages, unmatched files, and other projects' files are left out.
	 */
	readonly references: (symbol: Symbol) => Effect.Effect<ReadonlyArray<Reference>, UnknownError>;
};

/**
 * Options of a project transform.
 *
 * @since @next
 */
export type Options<Payload> = {
	/** Globs relative to the run's root that select the files of the action. */
	readonly include: (payload: Payload) => ReadonlyArray<string>;
};

/**
 * Options of a Promise project transform.
 *
 * @since @next
 */
export type PromiseOptions<
	Payload,
	S extends Handler.ServiceMap,
	G extends ReadonlyArray<Handler.ErrorGuard>,
> = Options<Payload> & {
	/** Effect services resolved for the transform and added to the handler requirements. */
	readonly services?: S;
	/** Guards for rejections that keep their own type. Other rejections become `UnknownError`. */
	readonly errors?: G;
};

type Operations = {
	readonly sourceFile: (path: string) => Promise<SourceFile>;
	readonly references: (symbol: Symbol) => Promise<ReadonlyArray<Reference>>;
};

const operations = (unit: Unit): Operations => {
	const allowed = new Set(unit.files);

	return {
		sourceFile: async (path) => {
			const source = unit.sources.get(path);
			if (source === undefined || !allowed.has(path)) {
				throw new EditRejected({
					path,
					reason: "The path is not a matched file of this project",
					ranges: [],
				});
			}

			return source;
		},
		references: async (symbol) => {
			const [declaration] = symbol.declarations;
			if (declaration === undefined) return [];
			const node = await declaration.resolve(unit.project);
			if (node === undefined) return [];
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Declarations with names expose them as `name`.
			const name = (node as Node & { readonly name?: Node }).name ?? node;
			const sourceFile = await unit.project.program.getSourceFile(declaration.path);
			if (sourceFile === undefined) return [];
			const entries = await unit.project.languageService.getReferencedSymbolsForNode(
				name,
				skipTrivia(sourceFile.text, name.pos),
			);

			const seen = new Set<string>();
			const references: Array<Reference> = [];
			for (const entry of entries) {
				for (const handle of entry.references) {
					const path = unit.pathOf(String(handle.path));
					if (path === undefined || !allowed.has(path)) continue;
					const resolved = await handle.resolve(unit.project);
					if (resolved === undefined) continue;
					const key = `${path}:${resolved.pos}:${resolved.end}`;
					if (seen.has(key)) continue;
					seen.add(key);
					references.push({ path, node: resolved, form: nameForm(resolved) });
				}
			}

			return references;
		},
	};
};

/** Turns a Promise operation into an Effect that fails with `UnknownError`. */
const liftPromise =
	<I, O>(call: (input: I) => Promise<O>) =>
	(input: I) =>
		Effect.tryPromise({
			try: () => call(input),
			catch: (cause) => (cause instanceof UnknownError ? cause : new UnknownError({ cause })),
		});

const checkPaths = <C>(
	unit: Unit,
	edits: ReadonlyArray<FileEdit>,
): UnitResult<C | EditRejected> => {
	const allowed = new Set(unit.files);
	const outside = edits.filter((edit) => !allowed.has(edit.path));
	if (outside.length === 0) return { failures: [], edits };

	return {
		failures: outside.map((edit) => ({
			project: unit.info,
			cause: new EditRejected({
				path: edit.path,
				reason: "The edit names a file outside this project's matched files",
				ranges: [{ pos: edit.pos, end: edit.end }],
			}),
		})),
		edits: [],
	};
};

const project = <A extends Action.Any, C, R>(
	action: A,
	options: Options<A["payload"]>,
	run: (
		unit: Unit,
	) => Effect.Effect<Result.Result<ReadonlyArray<FileEdit>, C | AdapterCause>, never, R>,
) =>
	Handler.effect(action, {
		prepare: (payload) =>
			prepare<C, R>(action, options.include(payload), (unit) =>
				unit.blocked
					? Effect.succeed({ failures: [], edits: [] })
					: Effect.map(run(unit), (result): UnitResult<C | AdapterCause> =>
							Result.isSuccess(result)
								? checkPaths(unit, result.success)
								: {
										failures: [
											{
												project: unit.info,
												cause: result.failure,
											} satisfies Failure<C | AdapterCause>,
										],
										edits: [],
									},
						),
			),
		apply: (pending) => apply(action.id, pending),
	});

/**
 * Edits the matched files with a Promise transform that runs once per compiler project.
 * The transform returns edits that carry their file's path; each file's edits refer to
 * its text as the transform received it. The handler computes every edit while
 * preparing, so a dry run reports whether any matched file would change, and writes
 * them when it applies.
 *
 * @example
 * ```ts
 * TypeScript.Project.promise(
 * 	renameA1,
 * 	async ({ payload, program, checker, references, edit }) => {
 * 		const member = await findMember(program, checker, payload);
 * 		if (member === undefined) return [];
 * 		return (await references(member)).map((ref) => edit.rename(ref.node, payload.to));
 * 	},
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
	) => PromiseLike<ReadonlyArray<FileEdit>> | ReadonlyArray<FileEdit>,
	options: PromiseOptions<A["payload"], S, G>,
): Handler.Handler<A, Errors<GuardedError<G[number]>>, Workspace | ServiceIds<S>> =>
	project<A, GuardedError<G[number]>, ServiceIds<S>>(action, options, (unit) =>
		Effect.flatMap(resolveServices(options.services), (services) => {
			const { sourceFile, references } = operations(unit);

			return runPromise(
				(signal) =>
					transform({
						payload: action.payload,
						project: unit.info,
						files: unit.files,
						program: unit.project.program,
						checker: unit.project.checker,
						edit: unit.edits(unit.files),
						sourceFile,
						references,
						signal,
						services,
					}),
				classify(options.errors ?? []),
			);
		}),
	);

/**
 * Edits the matched files with an Effect transform that runs once per compiler project.
 * The transform keeps its own errors and services; a defect becomes `UnknownError`.
 *
 * @since @next
 */
export const effect = <A extends Action.Any, E = never, R = never>(
	action: A,
	transform: (
		context: EffectContext<A["payload"]>,
	) => Effect.Effect<ReadonlyArray<FileEdit>, E, R>,
	options: Options<A["payload"]>,
): Handler.Handler<A, Errors<E>, Workspace | Exclude<R, Scope.Scope>> =>
	project<A, E, R>(action, options, (unit) => {
		const { sourceFile, references } = operations(unit);
		return runEffect(
			Effect.suspend(() =>
				transform({
					payload: action.payload,
					project: unit.info,
					files: unit.files,
					program: unit.project.program,
					checker: unit.project.checker,
					edit: unit.edits(unit.files),
					sourceFile: liftPromise(sourceFile),
					references: liftPromise(references),
				}),
			),
		);
	});
