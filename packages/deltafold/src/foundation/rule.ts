import { Predicate } from "effect";

import type * as Action from "./action.ts";

/**
 * `Action.Parallel` matches a parallel group structurally by its branches (an explicit
 * structural rule).
 *
 * @since 0.0.1
 */
export type Pattern = Action.Any | Action.Parallel;

/** @since 0.0.1 */
export type Rule<A extends Action.Any = Action.Any> = {
	readonly _tag: "Rule";
	readonly id: string;
	readonly match: ReadonlyArray<Pattern>;
	/** An empty replacement cancels the match. */
	readonly replacement: ReadonlyArray<Action.Step<A>>;
};

/** @since 0.0.1 */
export type Any = Rule<any>;

/** @since 0.0.1 */
export type ActionsOf<R> = R extends Rule<infer A> ? A : never;

/**
 * Used for cancellation, composition, and supersession.
 *
 * The author asserts that the replacement is equivalent to the matched occurrences.
 * deltafold checks the rule's structure and where it applies, but it cannot prove the
 * equivalence.
 *
 * Ordinary rules match consecutive occurrences inside one sequential branch, including
 * across migration boundaries of a route. They never match across parallel branches.
 *
 * @example
 * ```ts
 * const cancelRoundTrip = Rule.replace("cancel-timeout-round-trip", {
 * 	match: [renameTimeout, restoreTimeout],
 * 	replacement: [],
 * });
 * const combineRenames = Rule.replace("combine-renames", {
 * 	match: [renameAtoB, renameBtoC],
 * 	replacement: [renameAtoC],
 * });
 * ```
 *
 * @since 0.0.1
 */
export const replace = <A extends Action.Any = never>(
	id: string,
	options: {
		readonly match: ReadonlyArray<Pattern>;
		readonly replacement: ReadonlyArray<Action.Step<A>>;
	},
): Rule<A> => ({
	_tag: "Rule",
	id,
	match: options.match,
	replacement: options.replacement,
});

/** @since 0.0.1 */
export const isRule = (value: unknown): value is Any => Predicate.isTagged(value, "Rule");
