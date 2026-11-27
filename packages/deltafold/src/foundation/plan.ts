import type * as Action from "./action.ts";
import type * as Change from "./change.ts";
import type { Instruction, Text } from "./instruction.ts";
import type * as Migration from "./migration.ts";
import type * as Rule from "./rule.ts";
import type * as Shortcut from "./shortcut.ts";
import type { Version } from "./version.ts";

/** @since 0.0.1 */
export type Direction = "forward" | "revert";

/** @since 0.0.1 */
export type Origin =
	| { readonly _tag: "Declared" }
	| {
			readonly _tag: "Replacement";
			readonly rule: Rule.Any;
			readonly replaces: ReadonlyArray<Occurrence>;
	  };

/**
 * One scheduled execution of an action instance in a plan.
 *
 * @since 0.0.1
 */
export type Occurrence<A extends Action.Any = Action.Any> = {
	readonly _tag: "Occurrence";
	/**
	 * Unique within the plan and stable across prose edits. Built from the migration,
	 * direction, and action identifiers, or from the rule and replaced occurrences;
	 * separator characters are escaped with a backslash so identifiers never collide.
	 */
	readonly id: string;
	readonly action: A;
	/** The migration whose step contains this occurrence. */
	readonly migration: Migration.Any;
	readonly direction: Direction;
	readonly instruction: Instruction | undefined;
	readonly origin: Origin;
};

/** @since 0.0.1 */
export type Sequence<A extends Action.Any = Action.Any> = {
	readonly _tag: "Sequence";
	readonly children: ReadonlyArray<Node<A>>;
};

/** @since 0.0.1 */
export type Parallel<A extends Action.Any = Action.Any> = {
	readonly _tag: "Parallel";
	readonly branches: ReadonlyArray<Node<A>>;
	readonly concurrency: Action.Concurrency;
};

/** @since 0.0.1 */
export type Node<A extends Action.Any = Action.Any> = Occurrence<A> | Sequence<A> | Parallel<A>;

/**
 * Occurrences render as their instruction or description.
 *
 * @since 0.0.1
 */
export type GuideItem<A extends Action.Any = Action.Any> =
	| Text
	| Action.Ref
	| { readonly _tag: "Occurrence"; readonly occurrence: Occurrence<A> }
	| {
			readonly _tag: "Group";
			readonly kind: "Sequence" | "Parallel";
			/** One entry per retained child or branch. */
			readonly children: ReadonlyArray<ReadonlyArray<GuideItem<A>>>;
	  };

/**
 * Sequential barrier: a step starts only after the previous step completes.
 *
 * @since 0.0.1
 */
export type Step<A extends Action.Any = Action.Any> = {
	readonly _tag: "Step";
	/**
	 * Identifies the migration side within the route: the migration identifier, followed by
	 * `/revert` for a reverse migration. Declared occurrence identifiers start with it.
	 *
	 * @since 0.2.1
	 */
	readonly id: string;
	readonly migration: Migration.Any;
	readonly direction: Direction;
	readonly from: Version;
	readonly to: Version;
	readonly node: Sequence<A>;
	/** Empty when `omitted` is `true`. */
	readonly guide: ReadonlyArray<GuideItem<A>>;
	/**
	 * Whether the normal resolved guide leaves this step out: a noop, or a migration whose
	 * actions were all removed by rules.
	 */
	readonly omitted: boolean;
};

/** @since 0.0.1 */
export type Explanation =
	| {
			readonly _tag: "Rewrite";
			readonly rule: Rule.Any;
			readonly removed: ReadonlyArray<Occurrence>;
			readonly produced: ReadonlyArray<Occurrence>;
	  }
	| {
			readonly _tag: "OmittedStep";
			readonly migration: Migration.Any;
			readonly direction: Direction;
			readonly reason: "noop" | "all-actions-removed";
	  };

/** @since 0.0.1 */
export type Hop =
	| {
			readonly _tag: "Migrations";
			readonly from: Version;
			readonly to: Version;
			/** Holds exactly one entry; validation allows one migration side per transition. */
			readonly migrations: ReadonlyArray<{
				readonly migration: Migration.Any;
				readonly direction: Direction;
			}>;
	  }
	| {
			readonly _tag: "Shortcut";
			readonly from: Version;
			readonly to: Version;
			readonly shortcut: Shortcut.Any;
	  };

/** @since 0.0.1 */
export type Route = {
	/**
	 * Identifies the route for explicit selection: version identifiers joined by `>`,
	 * with shortcut hops written as `[shortcut-id]`. A backslash escapes `\`, `>`, `[`,
	 * and `]` inside identifiers, so a version `a>b` appears as `a\>b`.
	 */
	readonly id: string;
	readonly hops: ReadonlyArray<Hop>;
};

/**
 * How the requested target relates to the source in release ancestry.
 *
 * @since 0.0.1
 */
export type RequestDirection = "none" | "upgrade" | "downgrade" | "cross-branch";

/**
 * `"static"` also exposes uncovered actions in the execution's type.
 *
 * @since 0.0.1
 */
export type Coverage = "static" | "runtime";

/**
 * A resolved, optimized route between two versions. Every step stays traceable to its
 * migration and the changes that migration addresses.
 *
 * @since 0.0.1
 */
export type Plan<
	A extends Action.Any = Action.Any,
	C extends Coverage = "static",
	Ch extends Change.Any = Change.Any,
> = {
	readonly _tag: "Plan";
	readonly from: Version;
	readonly to: Version;
	readonly direction: RequestDirection;
	readonly route: Route;
	readonly steps: ReadonlyArray<Step<A>>;
	/** In plan order. */
	readonly occurrences: ReadonlyArray<Occurrence<A>>;
	/** The changes addressed by the route's migrations. */
	readonly changes: ReadonlyArray<Ch>;
	readonly explanations: ReadonlyArray<Explanation>;
	/** Plans resolved from a history are checked statically against its conservative action union. */
	readonly coverage: C;
};

/** @since 0.0.1 */
export type Any = Plan<any, any>;

/** @since 0.0.1 */
export type ActionsOf<P> = P extends Plan<infer A, any> ? A : never;

/**
 * Whether the plan has no action occurrences. An empty plan is valid.
 *
 * @since 0.0.1
 */
export const isEmpty = (plan: Any): boolean => plan.occurrences.length === 0;

/**
 * Use for dynamically selected or loaded plans whose action union is not known
 * statically. Executors still reject missing handlers before any action body runs.
 *
 * @since 0.0.1
 */
export const withRuntimeCoverage = <A extends Action.Any, Ch extends Change.Any>(
	plan: Plan<A, Coverage, Ch>,
): Plan<A, "runtime", Ch> => ({
	...plan,
	coverage: "runtime",
});
