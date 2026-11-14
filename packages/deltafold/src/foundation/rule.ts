import { Predicate } from "effect";

import type * as Action from "./action.ts";

/**
 * What a rule matches: an action instance, or a parallel group matched by its branch
 * structure. Matching a parallel group is an explicit structural rule.
 *
 * @since @next
 */
export type Pattern = Action.Any | Action.Parallel;

/** @since @next */
export type Rule<A extends Action.Any = Action.Any> = {
	readonly _tag: "Rule";
	readonly id: string;
	readonly match: ReadonlyArray<Pattern>;
	/** Steps that take the place of the match. An empty replacement cancels it. */
	readonly replacement: ReadonlyArray<Action.Step<A>>;
};

/**
 * Any rule.
 *
 * @since @next
 */
export type Any = Rule<any>;

/**
 * The action instances a rule can contribute to a plan.
 *
 * @since @next
 */
export type ActionsOf<R> = R extends Rule<infer A> ? A : never;

/**
 * Declares a replacement. Cancellation, composition, and supersession all use it.
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
 * @since @next
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

/** @since @next */
export const isRule = (value: unknown): value is Any => Predicate.isTagged(value, "Rule");
