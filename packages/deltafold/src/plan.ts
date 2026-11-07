/**
 * Plans are resolved, optimized routes between two versions. Every step stays traceable
 * to its action, migration, and the changes the migration addresses.
 *
 * @packageDocumentation
 */
import type * as Action from "./action.ts";
import type { Change } from "./change.ts";
import type { Instruction, Text } from "./instruction.ts";
import type * as Migration from "./migration.ts";
import type * as Rule from "./rule.ts";
import type * as Shortcut from "./shortcut.ts";
import type { Version } from "./version.ts";

/** Which side of a migration runs. */
export type Direction = "forward" | "revert";

/** How an occurrence entered the plan. */
export type Origin =
	| { readonly _tag: "Declared" }
	| {
			readonly _tag: "Replacement";
			readonly rule: Rule.Any;
			/** The occurrences the rule replaced, in order. */
			readonly replaces: ReadonlyArray<Occurrence>;
	  };

/**
 * One execution of an action instance in a plan. Its `id` is stable across prose edits:
 * it combines the migration, direction, and action identifiers, or the rule and the
 * replaced occurrences for a replacement.
 */
export type Occurrence<A extends Action.Any = Action.Any> = {
	readonly _tag: "Occurrence";
	readonly id: string;
	readonly action: A;
	/** The migration whose step contains this occurrence. */
	readonly migration: Migration.Any;
	readonly direction: Direction;
	/** The instruction block that declared this occurrence, if any. */
	readonly instruction: Instruction | undefined;
	readonly origin: Origin;
};

export type Sequence<A extends Action.Any = Action.Any> = {
	readonly _tag: "Sequence";
	readonly children: ReadonlyArray<Node<A>>;
};

export type Parallel<A extends Action.Any = Action.Any> = {
	readonly _tag: "Parallel";
	readonly branches: ReadonlyArray<Node<A>>;
	readonly concurrency: Action.Concurrency;
};

/** The declared execution structure. */
export type Node<A extends Action.Any = Action.Any> = Occurrence<A> | Sequence<A> | Parallel<A>;

/** Resolved prose for a guide. Occurrences render as their instruction or description. */
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
 * One migration in the route. Steps are sequential barriers: a step starts only after
 * the previous step completed.
 */
export type Step<A extends Action.Any = Action.Any> = {
	readonly _tag: "Step";
	readonly migration: Migration.Any;
	readonly direction: Direction;
	readonly from: Version;
	readonly to: Version;
	readonly node: Sequence<A>;
	/** Resolved guide content. Empty when the step is omitted from the guide. */
	readonly guide: ReadonlyArray<GuideItem<A>>;
	/**
	 * Whether the normal resolved guide leaves this step out: a noop, or a migration whose
	 * actions were all removed by rules.
	 */
	readonly omitted: boolean;
};

/** Why the plan differs from the declared migrations. */
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

/** A hop in a route: the migrations between two versions, or a shortcut. */
export type Hop =
	| {
			readonly _tag: "Migrations";
			readonly from: Version;
			readonly to: Version;
			/** Complementary migrations with these endpoints, in registration order. */
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

export type Route = {
	/**
	 * Identifies the route for explicit selection: version identifiers joined by `>`,
	 * with shortcut hops written as `[shortcut-id]`.
	 */
	readonly id: string;
	readonly hops: ReadonlyArray<Hop>;
};

/** How the requested target relates to the source in release ancestry. */
export type RequestDirection = "none" | "upgrade" | "downgrade" | "cross-branch";

export type Plan<A extends Action.Any = Action.Any> = {
	readonly _tag: "Plan";
	readonly from: Version;
	readonly to: Version;
	readonly direction: RequestDirection;
	readonly route: Route;
	readonly steps: ReadonlyArray<Step<A>>;
	/** Occurrences in plan order. */
	readonly occurrences: ReadonlyArray<Occurrence<A>>;
	/** The changes addressed by the route's migrations. */
	readonly changes: ReadonlyArray<Change>;
	readonly explanations: ReadonlyArray<Explanation>;
	/**
	 * Whether executors check handler coverage only at run time. Plans resolved from a
	 * history are checked statically against its conservative action union.
	 */
	readonly coverage: "static" | "runtime";
};

/** Any plan. */
export type Any = Plan<any>;

/** The action instances of a plan. */
export type ActionsOf<P> = P extends Plan<infer A> ? A : never;

/** Whether the plan has no action occurrences. An empty plan is valid. */
export const isEmpty = (plan: Any): boolean => plan.occurrences.length === 0;

/**
 * Marks a plan for run-time coverage checks only. Use it for dynamically selected or
 * loaded plans whose action union is not known statically. Executors still reject
 * missing handlers before any action body runs.
 */
export const withRuntimeCoverage = (plan: Any): Plan<Action.Action> => ({
	...plan,
	coverage: "runtime",
});
