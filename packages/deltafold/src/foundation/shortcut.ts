import { Predicate } from "effect";

import type * as Action from "./action.ts";
import type * as Migration from "./migration.ts";
import type { Version } from "./version.ts";

/** @since @next */
export type Shortcut<A extends Action.Any = Action.Any> = {
	readonly _tag: "Shortcut";
	readonly id: string;
	readonly from: Version;
	readonly to: Version;
	/** The canonical route this shortcut replaces, in order. */
	readonly replaces: ReadonlyArray<Migration.Any>;
	/** The migrations that run instead, in order. */
	readonly migrations: ReadonlyArray<Migration.Migration<A>>;
	/** Author-declared cost, used only by the `lowest-cost` route policy. */
	readonly cost: number | undefined;
};

/**
 * Any shortcut.
 *
 * @since @next
 */
export type Any = Shortcut<any>;

/**
 * The action instances a shortcut can contribute to a plan.
 *
 * @since @next
 */
export type ActionsOf<S> = S extends Shortcut<infer A> ? A : never;

/**
 * Declares a shortcut. The author asserts that its migrations are equivalent to the
 * canonical route it replaces; deltafold does not prove it.
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
 * @since @next
 */
export const make = <M extends Migration.Any>(
	id: string,
	options: {
		readonly from: Version;
		readonly to: Version;
		readonly replaces: ReadonlyArray<Migration.Any>;
		readonly migrations: ReadonlyArray<M>;
		readonly cost?: number;
	},
): Shortcut<Migration.ActionsOf<M>> => ({
	_tag: "Shortcut",
	id,
	from: options.from,
	to: options.to,
	replaces: options.replaces,
	migrations: options.migrations,
	cost: options.cost,
});

/** @since @next */
export const isShortcut = (value: unknown): value is Any => Predicate.isTagged(value, "Shortcut");
