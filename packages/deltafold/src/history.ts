/**
 * Histories register versions, migrations, rules, and shortcuts, and resolve plans
 * between versions. Planning needs no handlers or execution services, and never
 * inspects or modifies consumer files.
 *
 * @packageDocumentation
 */
import { Predicate, Result } from "effect";

import type * as Action from "./action.ts";
import {
	destinations,
	lookup as lookupVersion,
	makeContext,
	resolve as resolveRoute,
	type Context,
	type Destination,
	type ResolveOptions,
	type RoutePolicy,
} from "./internal/resolve.ts";
import { validate as validateDeclarations, type Issue } from "./internal/validate.ts";
import type * as Migration from "./migration.ts";
import type { Plan } from "./plan.ts";
import { InvalidHistory, type ResolveError, type UnknownVersion } from "./resolve-error.ts";
import type * as Rule from "./rule.ts";
import type * as Shortcut from "./shortcut.ts";
import type { Version } from "./version.ts";

export * from "./resolve-error.ts";
export type { Destination, Issue, ResolveOptions, RoutePolicy };

export type History<A extends Action.Any = Action.Any> = {
	readonly _tag: "History";
	readonly versions: ReadonlyArray<Version>;
	readonly migrations: ReadonlyArray<Migration.Any>;
	readonly rules: ReadonlyArray<Rule.Any>;
	readonly shortcuts: ReadonlyArray<Shortcut.Any>;
	/** Type-level record of every action instance that a plan can contain. */
	readonly "~actions"?: A;
};

/** Any history. */
export type Any = History<any>;

/** Every action instance that a plan resolved from the history can contain. */
export type ActionsOf<H> = H extends History<infer A> ? A : never;

/**
 * Registers declarations. Migrations are registered independently of versions, so
 * routes can be added later without changing published release definitions.
 *
 * `make` does not throw. Use `History.validate` to list declaration issues;
 * resolution fails with `InvalidHistory` when there are any.
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
	Migration.ActionsOf<M[number]> | Rule.ActionsOf<R[number]> | Shortcut.ActionsOf<S[number]>
> => ({
	_tag: "History",
	versions: declarations.versions,
	migrations: declarations.migrations,
	rules: declarations.rules ?? [],
	shortcuts: declarations.shortcuts ?? [],
});

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

/** Lists declaration issues in a deterministic order. An empty list means valid. */
export const validate = (history: Any): ReadonlyArray<Issue> => prepare(history).issues;

const valid = (history: Any): Result.Result<Context, InvalidHistory> => {
	const { issues, context } = prepare(history);

	return issues.length === 0
		? Result.succeed(context)
		: Result.fail(new InvalidHistory({ issues }));
};

/**
 * Resolves an optimized plan between two versions.
 *
 * When several routes connect the versions, resolution fails with `AmbiguousRoute`
 * unless the `route` option selects one or a route `policy` leaves exactly one.
 *
 * @example
 * ```ts
 * const result = History.resolve(history, { from: "1.5.3", to: "2.0.0" });
 * if (Result.isSuccess(result)) console.log(result.success.route.id);
 * ```
 */
export const resolve = <A extends Action.Any>(
	history: History<A>,
	options: ResolveOptions,
): Result.Result<Plan<A>, ResolveError> =>
	// Every occurrence comes from the history's declarations, whose action union is `A`.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	Result.flatMap(valid(history), (context) => resolveRoute(context, options)) as Result.Result<
		Plan<A>,
		ResolveError
	>;

/** Destinations reachable by upgrade from a version, with their candidate routes. */
export const upgrades = (
	history: Any,
	options: { readonly from: Version | string },
): Result.Result<ReadonlyArray<Destination>, InvalidHistory | UnknownVersion> =>
	reachableFrom(history, options.from, "upgrade");

/** Destinations reachable by downgrade from a version, with their candidate routes. */
export const downgrades = (
	history: Any,
	options: { readonly from: Version | string },
): Result.Result<ReadonlyArray<Destination>, InvalidHistory | UnknownVersion> =>
	reachableFrom(history, options.from, "downgrade");

const reachableFrom = (history: Any, from: Version | string, kind: "upgrade" | "downgrade") =>
	Result.flatMap(valid(history), (context) =>
		Result.map(lookupVersion(context, from), (version) => destinations(context, version, kind)),
	);
