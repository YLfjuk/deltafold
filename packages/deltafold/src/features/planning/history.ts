import { Predicate, Result } from "effect";

import type * as Action from "../../foundation/action.ts";
import type * as Change from "../../foundation/change.ts";
import type * as Migration from "../../foundation/migration.ts";
import type { Plan } from "../../foundation/plan.ts";
import type * as Rule from "../../foundation/rule.ts";
import type * as Shortcut from "../../foundation/shortcut.ts";
import type { Version } from "../../foundation/version.ts";
import { InvalidHistory, type ResolveError, type UnknownVersion } from "./resolve-error.ts";
import {
	destinations,
	lookup as lookupVersion,
	makeContext,
	resolve as resolveRoute,
	type Context,
	type Destination,
	type ResolveOptions,
	type RoutePolicy,
} from "./resolve.ts";
import { validate as validateDeclarations, type Issue } from "./validate.ts";

export * from "./resolve-error.ts";
export type { Destination, Issue, ResolveOptions, RoutePolicy };

/** @since @next */
export type History<A extends Action.Any = Action.Any, C extends Change.Any = Change.Any> = {
	readonly _tag: "History";
	readonly versions: ReadonlyArray<Version>;
	readonly migrations: ReadonlyArray<Migration.Any>;
	readonly rules: ReadonlyArray<Rule.Any>;
	readonly shortcuts: ReadonlyArray<Shortcut.Any>;
	/** Type-level record of every action instance that a plan can contain. */
	readonly "~actions"?: A;
	/** Type-level record of every change that a plan's `changes` can contain. */
	readonly "~changes"?: C;
};

/**
 * Any history.
 *
 * @since @next
 */
export type Any = History<any>;

/**
 * Every action instance that a plan resolved from the history can contain.
 *
 * @since @next
 */
export type ActionsOf<H> = H extends History<infer A> ? A : never;

/**
 * Every change that a plan resolved from the history can list in `changes`.
 *
 * @since @next
 */
export type ChangesOf<H> = H extends History<any, infer C> ? C : never;

/**
 * Registers declarations. Migrations are registered independently of versions, so
 * routes can be added later without changing published release definitions.
 *
 * `make` does not throw. Use `History.validate` to list declaration issues;
 * resolution fails with `InvalidHistory` when there are any.
 *
 * @since @next
 */
export const make = <
	const M extends ReadonlyArray<Migration.Any>,
	const R extends ReadonlyArray<Rule.Any> = [],
	const S extends ReadonlyArray<Shortcut.Any> = [],
>(declarations: {
	readonly versions: ReadonlyArray<Version>;
	readonly migrations: M;
	readonly rules?: R;
	readonly shortcuts?: S;
}): History<
	Migration.ActionsOf<M[number]> | Rule.ActionsOf<R[number]> | Shortcut.ActionsOf<S[number]>,
	Migration.ChangesOf<M[number]> | Shortcut.ChangesOf<S[number]>
> => ({
	_tag: "History",
	versions: declarations.versions,
	migrations: declarations.migrations,
	rules: declarations.rules ?? [],
	shortcuts: declarations.shortcuts ?? [],
});

/** @since @next */
export const isHistory = (value: unknown): value is Any => Predicate.isTagged(value, "History");

const contexts = new WeakMap<
	Any,
	{ readonly issues: ReadonlyArray<Issue>; readonly context: Context }
>();

const prepare = (history: Any) => {
	const cached = contexts.get(history);
	if (cached !== undefined) return cached;

	const prepared = { issues: validateDeclarations(history), context: makeContext(history) };
	contexts.set(history, prepared);

	return prepared;
};

/**
 * Lists declaration issues in a deterministic order. An empty list means valid.
 *
 * @since @next
 */
export const validate = (history: Any): ReadonlyArray<Issue> => prepare(history).issues;

const valid = (history: Any): Result.Result<Context, InvalidHistory> => {
	const { issues, context } = prepare(history);

	return issues.length === 0
		? Result.succeed(context)
		: Result.fail(new InvalidHistory({ issues }));
};

/**
 * Resolves an optimized plan between two versions. Planning needs no handlers or
 * execution services, and it never reads or modifies consumer files.
 *
 * When several routes connect the versions, resolution fails with `AmbiguousRoute`
 * unless the `route` option selects one or a route `policy` leaves exactly one.
 *
 * @example
 * ```ts
 * const result = History.resolve(history, { from: "1.5.3", to: "2.0.0" });
 * if (Result.isSuccess(result)) console.log(result.success.route.id);
 * ```
 *
 * @since @next
 */
export const resolve = <A extends Action.Any, C extends Change.Any>(
	history: History<A, C>,
	options: ResolveOptions,
): Result.Result<Plan<A, "static", C>, ResolveError> =>
	// Every occurrence and change comes from the history's declarations, whose unions are
	// `A` and `C`.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	Result.flatMap(valid(history), (context) => resolveRoute(context, options)) as Result.Result<
		Plan<A, "static", C>,
		ResolveError
	>;

/**
 * Destinations reachable by upgrade from a version, with their candidate routes.
 *
 * @since @next
 */
export const upgrades = (
	history: Any,
	options: { readonly from: Version | string },
): Result.Result<ReadonlyArray<Destination>, InvalidHistory | UnknownVersion> =>
	reachableFrom(history, options.from, "upgrade");

/**
 * Destinations reachable by downgrade from a version, with their candidate routes.
 *
 * @since @next
 */
export const downgrades = (
	history: Any,
	options: { readonly from: Version | string },
): Result.Result<ReadonlyArray<Destination>, InvalidHistory | UnknownVersion> =>
	reachableFrom(history, options.from, "downgrade");

const reachableFrom = (history: Any, from: Version | string, kind: "upgrade" | "downgrade") =>
	Result.flatMap(valid(history), (context) =>
		Result.map(lookupVersion(context, from), (version) => destinations(context, version, kind)),
	);
