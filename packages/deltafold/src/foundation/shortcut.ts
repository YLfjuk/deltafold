import { Predicate } from "effect";

import type * as Action from "./action.ts";
import type * as Change from "./change.ts";
import type * as Migration from "./migration.ts";
import type { Version } from "./version.ts";

/** @since 0.0.1 */
export type Shortcut<A extends Action.Any = Action.Any, C extends Change.Any = Change.Any> = {
	readonly _tag: "Shortcut";
	readonly id: string;
	readonly from: Version;
	readonly to: Version;
	/** The canonical route this shortcut replaces, in order. */
	readonly replaces: ReadonlyArray<Migration.Any>;
	readonly migrations: ReadonlyArray<Migration.Migration<A, C>>;
	/** Used only by the `lowest-cost` route policy. */
	readonly cost: number | undefined;
};

/** @since 0.0.1 */
export type Any = Shortcut<any>;

/** @since 0.0.1 */
export type ActionsOf<S> = S extends Shortcut<infer A> ? A : never;

/** @since 0.0.1 */
export type ChangesOf<S> = S extends Shortcut<any, infer C> ? C : never;

/**
 * The author asserts that its migrations are equivalent to the canonical route it
 * replaces; deltafold does not prove it.
 *
 * @example
 * ```ts
 * const fastUpgrade = Shortcut.make("fast-upgrade", {
 * 	from: v201,
 * 	to: v208,
 * 	replaces: [migrate202, migrate203, migrate204],
 * 	migrations: [migrateDirectlyTo208],
 * });
 * ```
 *
 * @since 0.0.1
 */
export const make = <A extends Action.Any, C extends Change.Any = never>(
	id: string,
	options: {
		readonly from: Version;
		readonly to: Version;
		readonly replaces: ReadonlyArray<Migration.Any>;
		readonly migrations: ReadonlyArray<Migration.Migration<A, C>>;
		readonly cost?: number;
	},
): Shortcut<A, C> => ({
	_tag: "Shortcut",
	id,
	from: options.from,
	to: options.to,
	replaces: options.replaces,
	migrations: options.migrations,
	cost: options.cost,
});

/** @since 0.0.1 */
export const isShortcut = (value: unknown): value is Any => Predicate.isTagged(value, "Shortcut");
