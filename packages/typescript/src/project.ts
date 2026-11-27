import type { Scope } from "effect";
import { Effect, Result } from "effect";
import type { Node, SourceFile } from "typescript-7.1/ast";
import { skipTrivia } from "typescript-7.1/ast/scanner";
import type { Checker, Program, Symbol } from "typescript-7.1/async";

import type { Action } from "deltafold";
import { Handler } from "deltafold";
import type { Edits, FileEdit, NameForm } from "./edits.ts";
import { nameForm } from "./edits.ts";
import type { NoServices, ResolvedServices, ServiceIds, Unit, UnitResult } from "./engine.ts";
import {
	apply,
	classify,
	prepare,
	resolveServices,
	runEffect,
	runPromise,
	unexpected,
} from "./engine.ts";
import type { AdapterCause, Errors, Failure, GuardedError } from "./errors.ts";
import { EditRejected } from "./errors.ts";
import type { Workspace } from "./workspace.ts";

/**
 * `config` is relative to the root when the tsconfig file is under it. An inferred
 * project holds files outside every tsconfig file.
 *
 * @since @next
 */
export type Info =
	| { readonly kind: "configured"; readonly config: string }
	| { readonly kind: "inferred"; readonly id: string };

/** @since @next */
export type Reference = {
	/** Root-relative and `/`-separated. */
	readonly path: string;
	/** The name, such as the `a1` in `value.a1`. */
	readonly node: Node;
	readonly form: NameForm;
};

/** @since @next */
export type Context<Payload> = {
	readonly payload: Payload;
	readonly project: Info;
	/**
	 * The only files the transform may edit. It does not run while any of them has
	 * syntax errors.
	 */
	readonly files: ReadonlyArray<string>;
	/** Includes installed declarations. */
	readonly program: Program;
	readonly checker: Checker;
	readonly edit: Edits;
};

/** @since @next */
export type PromiseContext<
	Payload,
	S extends Handler.ServiceMap = NoServices,
> = Context<Payload> & {
	readonly sourceFile: (path: string) => Promise<SourceFile>;
	/**
	 * Finds the uses of a symbol in `files` with the compiler's find-references. It leaves
	 * out uses in installed packages, unmatched files, and other projects.
	 */
	readonly references: (symbol: Symbol) => Promise<ReadonlyArray<Reference>>;
	/** Aborted when the action is interrupted. */
	readonly signal: AbortSignal;
	readonly services: ResolvedServices<S>;
};

/** @since @next */
export type EffectContext<Payload> = Context<Payload> & {
	readonly sourceFile: (
		path: string,
	) => Effect.Effect<SourceFile, Handler.UnexpectedHandlerError>;
	/**
	 * Finds the uses of a symbol in `files` with the compiler's find-references. It leaves
	 * out uses in installed packages, unmatched files, and other projects.
	 */
	readonly references: (
		symbol: Symbol,
	) => Effect.Effect<ReadonlyArray<Reference>, Handler.UnexpectedHandlerError>;
};

/** @since @next */
export type Options<Payload> = {
	/** Globs relative to the run's root. */
	readonly include: (payload: Payload) => ReadonlyArray<string>;
};

/** @since @next */
export type PromiseOptions<
	Payload,
	S extends Handler.ServiceMap,
	G extends ReadonlyArray<Handler.ErrorGuard>,
> = Options<Payload> & {
	/** The transform receives them as `services`, and the handler requires them. */
	readonly services?: S;
	/** Errors these guards recognize keep their type. Others become `Handler.UnexpectedHandlerError`. */
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

const liftPromise =
	<I, O>(action: Action.Any, call: (input: I) => Promise<O>) =>
	(input: I) =>
		Effect.tryPromise({ try: () => call(input), catch: (cause) => unexpected(action, cause) });

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
 * Runs a transform once per compiler project. The handler computes edits in its prepare
 * phase and writes them in its apply phase, so a dry run shows whether any file would
 * change.
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
				classify(action, options.errors ?? []),
			);
		}),
	);

/**
 * Runs a transform once per compiler project. A defect becomes
 * `Handler.UnexpectedHandlerError`.
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
			action,
			Effect.suspend(() =>
				transform({
					payload: action.payload,
					project: unit.info,
					files: unit.files,
					program: unit.project.program,
					checker: unit.project.checker,
					edit: unit.edits(unit.files),
					sourceFile: liftPromise(action, sourceFile),
					references: liftPromise(action, references),
				}),
			),
		);
	});
