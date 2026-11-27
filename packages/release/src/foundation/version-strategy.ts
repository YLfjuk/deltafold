import { Predicate } from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";

import type { Change } from "deltafold";
import * as PackageConfig from "../configs/package.ts";
import type * as VersionScheme from "./version-scheme.ts";

/** @since 0.0.1 */
export const TypeId = `~${PackageConfig.name}/VersionStrategy`;

/** @since 0.0.1 */
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

/** @since 0.0.1 */
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
 * Must be pure and synchronous: the planner may call it several times for one plan.
 * Build one with `VersionStrategy.make`; plain functions are refused.
 *
 * @since 0.0.1
 */
export type VersionStrategy<M extends object, V, I = undefined, D = undefined> = {
	(context: Context<M, V, I>): Calculation<V, D>;
	readonly [TypeId]: typeof TypeId;
	readonly name: string;
	readonly scheme: VersionScheme.VersionScheme<V>;
	/**
	 * Run synchronously by the planner before calculating, with its output passed to the
	 * strategy; asynchronous validation is refused.
	 */
	readonly input: StandardSchemaV1<unknown, I> | undefined;
};

/** @since 0.0.1 */
export type Any = VersionStrategy<any, any, any, any>;

/** @since 0.0.1 */
export type InputOf<S> = S extends VersionStrategy<any, any, infer I, any> ? I : never;

/** @since 0.0.1 */
export type VersionOf<S> = S extends VersionStrategy<any, infer V, any, any> ? V : never;

/** @since 0.0.1 */
export type DetailsOf<S> = S extends VersionStrategy<any, any, any, infer D> ? D : never;

/** @since 0.0.1 */
export type InputOption<I> = [I] extends [undefined]
	? { readonly input?: undefined }
	: { readonly input: StandardSchemaV1<unknown, I> };

/**
 * Without `input`, the strategy takes no per-plan input. When `input` is given, the
 * planner validates it synchronously with that Standard Schema before each calculation
 * and passes its output to `calculate`.
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
 * Reported by the planner as `StrategyRefused`, naming the strategy.
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
 * Throws a `StrategyRefusal` so the planner reports `StrategyRefused`; other thrown
 * errors are reported as `InvalidStrategyResult`.
 *
 * @since 0.0.1
 */
export const refuse = (message: string, subjects: ReadonlyArray<string> = []): never => {
	throw new StrategyRefusal(message, subjects);
};
