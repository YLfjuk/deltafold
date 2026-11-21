import { Predicate } from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";

import type { Change } from "deltafold";
import type * as VersionScheme from "./version-scheme.ts";

/** @since 0.0.1 */
export const TypeId = "~@deltafold/release/VersionStrategy";

/**
 * One package taking part in a calculation.
 *
 * @since 0.0.1
 */
export type Participant<M extends object, V> = {
	readonly package: string;
	readonly previous: V;
	/** `previous`, then its own previous, and so on, following history links, not precedence. */
	readonly ancestry: ReadonlyArray<V>;
	readonly changes: ReadonlyArray<Change.Change<M>>;
	/**
	 * Released dependencies whose range edits require this package to release. They are
	 * intent to release; they are not changes.
	 */
	readonly dependencies: ReadonlyArray<string>;
};

/** @since 0.0.1 */
export type Context<M extends object, V, I> = {
	readonly participants: ReadonlyArray<Participant<M, V>>;
	/** Per-plan options the strategy defines, such as SemVer's `{ pre }`. */
	readonly input: I;
};

/**
 * A strategy's result for one calculation.
 *
 * @since 0.0.1
 */
export type Calculation<V, D> = {
	/** The version every participant receives, unless `versions` names it otherwise. */
	readonly version: V;
	/** Participants that receive another version, or their own details. */
	readonly versions?: ReadonlyArray<{
		readonly package: string;
		readonly version: V;
		readonly details?: D;
	}>;
	/** What participants without changes do when the version advances. Defaults to `"align"`. */
	readonly unchanged?: "align" | "drift";
	/** Strategy-specific facts, surfaced on each planned version. */
	readonly details?: D;
};

/**
 * Decides the next version for its participants. It must be pure and synchronous: the
 * planner may call it several times for one plan. Build one with `VersionStrategy.make`;
 * plain functions are not strategies.
 *
 * @since 0.0.1
 */
export interface VersionStrategy<M extends object, V, I = undefined, D = undefined> {
	(context: Context<M, V, I>): Calculation<V, D>;
	readonly [TypeId]: typeof TypeId;
	readonly name: string;
	readonly scheme: VersionScheme.VersionScheme<V>;
	/**
	 * Validates per-plan input. The planner runs it synchronously before calculating and
	 * passes its output to the strategy; asynchronous validation is refused.
	 */
	readonly input: StandardSchemaV1<unknown, I> | undefined;
}

/**
 * Any version strategy.
 *
 * @since 0.0.1
 */
export type Any = VersionStrategy<any, any, any, any>;

/** @since 0.0.1 */
export type InputOf<S> = S extends VersionStrategy<any, any, infer I, any> ? I : never;

/** @since 0.0.1 */
export type VersionOf<S> = S extends VersionStrategy<any, infer V, any, any> ? V : never;

/** @since 0.0.1 */
export type DetailsOf<S> = S extends VersionStrategy<any, any, any, infer D> ? D : never;

/**
 * The input schema option: required when the strategy declares an input type, and absent
 * when it takes none, so an input type always has a schema behind it.
 *
 * @since 0.0.1
 */
export type InputOption<I> = [I] extends [undefined]
	? { readonly input?: undefined }
	: { readonly input: StandardSchemaV1<unknown, I> };

/**
 * Builds a version strategy. `input` is a Standard Schema for per-plan input, and its
 * output type is the input type. Without it, the strategy takes no input. The planner
 * validates input with it synchronously before each calculation and passes the output on.
 *
 * @example
 * ```ts
 * const calendar = VersionStrategy.make({
 * 	name: "calendar",
 * 	scheme: SemVerStrategy.scheme,
 * 	calculate: ({ participants }) => ({
 * 		version: SemVer.make({ major: 2026, minor: participants.length, patch: 0 }),
 * 	}),
 * });
 * ```
 *
 * @since 0.0.1
 */
export const make = <M extends object = object, V = never, I = undefined, D = undefined>(
	options: {
		readonly name: string;
		readonly scheme: VersionScheme.VersionScheme<V>;
		readonly calculate: (context: Context<M, V, I>) => Calculation<V, D>;
	} & InputOption<I>,
): VersionStrategy<M, V, I, D> => {
	const strategy = (context: Context<M, V, I>) => options.calculate(context);
	Object.defineProperty(strategy, "name", { value: options.name });

	return Object.assign(strategy, {
		[TypeId]: TypeId,
		scheme: options.scheme,
		input: options.input,
	} as const);
};

/** @since 0.0.1 */
export const isVersionStrategy = (value: unknown): value is Any =>
	Predicate.isFunction(value) && TypeId in value;

/**
 * A deliberate refusal by a strategy. The planner reports it as `StrategyRefused`, naming
 * the strategy.
 *
 * @since 0.0.1
 */
export class StrategyRefusal extends Error {
	readonly subjects: ReadonlyArray<string>;

	constructor(message: string, subjects: ReadonlyArray<string>) {
		super(message);
		this.name = "StrategyRefusal";
		this.subjects = subjects;
	}
}

/**
 * Refuses the calculation with a reason. Use it instead of throwing other errors, which
 * the planner reports as invalid strategy results.
 *
 * @since 0.0.1
 */
export const refuse = (message: string, subjects: ReadonlyArray<string> = []): never => {
	throw new StrategyRefusal(message, subjects);
};
