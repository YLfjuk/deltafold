/**
 * Action kinds describe consumer-owned operations. Action instances are concrete
 * instructions with stable identities. Groups declare sequential and parallel structure
 * between instructions.
 *
 * @packageDocumentation
 */
import { Predicate } from "effect";

import type { Instruction } from "./instruction.ts";

/**
 * Describes one kind of consumer-owned operation and its payload.
 *
 * @since @next
 */
export type Kind<P> = {
	readonly _tag: "ActionKind";
	readonly kind: string;
	readonly describe: (payload: P) => string;
	/** Creates an action instance with a stable identifier. */
	readonly make: <const Id extends string>(id: Id, payload: P) => Action<Id, P>;
};

/**
 * One concrete instruction. Its `id` identifies the instruction across plans, handler
 * bindings, rules, and reports.
 *
 * @since @next
 */
export type Action<Id extends string = string, P = unknown> = {
	readonly _tag: "Action";
	readonly id: Id;
	readonly kind: string;
	readonly payload: P;
	/** The description produced by the kind's `describe` function. */
	readonly description: string;
};

/**
 * Any action instance.
 *
 * @since @next
 */
export type Any = Action<string, any>;

/**
 * A mention of an action in prose. It does not declare an occurrence.
 *
 * @since @next
 */
export type Ref = {
	readonly _tag: "ActionRef";
	readonly action: Any;
};

/**
 * Children run one after another.
 *
 * @since @next
 */
export type Sequence<A extends Any = Any> = {
	readonly _tag: "Sequence";
	readonly children: ReadonlyArray<Step>;
	/** Type-level record of the action instances in `children`. */
	readonly "~actions"?: A;
};

/**
 * How many branches of a parallel group may run at the same time.
 *
 * @since @next
 */
export type Concurrency = number | "unbounded";

/**
 * Branches are independent of each other and may run concurrently. The group asserts
 * that independence; the concurrency limit only controls scheduling.
 *
 * @since @next
 */
export type Parallel<A extends Any = Any> = {
	readonly _tag: "Parallel";
	readonly branches: ReadonlyArray<Step>;
	readonly concurrency: Concurrency;
	/** Type-level record of the action instances in `branches`. */
	readonly "~actions"?: A;
};

/**
 * A node that declares action occurrences.
 *
 * @since @next
 */
export type Step<A extends Any = Any> = A | Instruction<A> | Sequence<A> | Parallel<A>;

/**
 * Extracts the action instances declared by a step.
 *
 * @since @next
 */
export type ActionsOf<S> =
	S extends Action<infer Id, infer P>
		? Action<Id, P>
		: S extends Instruction<infer A>
			? A
			: S extends Sequence<infer A>
				? A
				: S extends Parallel<infer A>
					? A
					: never;

/**
 * Defines an action kind.
 *
 * @example
 * ```ts
 * const RenameKey = Action.define<{ target: string; from: string; to: string }>(
 * 	"config.rename",
 * 	{ describe: ({ target, from, to }) => `In ${target}, rename "${from}" to "${to}"` },
 * );
 * const renameExportA = RenameKey.make("rename-export-a-timeout", {
 * 	target: "export-a",
 * 	from: "timeout",
 * 	to: "requestTimeout",
 * });
 * ```
 *
 * @since @next
 */
export const define = <P>(
	kind: string,
	options: { readonly describe?: (payload: P) => string } = {},
): Kind<P> => {
	const describe = options.describe ?? (() => kind);

	return {
		_tag: "ActionKind",
		kind,
		describe,
		make: (id, payload) => ({
			_tag: "Action",
			id,
			kind,
			payload,
			description: describe(payload),
		}),
	};
};

/**
 * Mentions an action in prose without declaring another occurrence.
 *
 * @since @next
 */
export const ref = (action: Any): Ref => ({ _tag: "ActionRef", action });

/**
 * Declares steps that run one after another.
 *
 * @since @next
 */
export const sequence = <const S extends ReadonlyArray<Step>>(
	children: S,
): Sequence<ActionsOf<S[number]>> => ({ _tag: "Sequence", children });

/**
 * Declares independent branches that may run concurrently. Each branch can be a single
 * step or a sequence.
 *
 * @since @next
 */
export const parallel = <const S extends ReadonlyArray<Step>>(
	branches: S,
	options: { readonly concurrency?: Concurrency } = {},
): Parallel<ActionsOf<S[number]>> => ({
	_tag: "Parallel",
	branches,
	concurrency: options.concurrency ?? "unbounded",
});

/** @since @next */
export const isAction = (value: unknown): value is Any =>
	Predicate.isTagged(value, "Action") && Predicate.hasProperty(value, "id");

/** @since @next */
export const isRef = (value: unknown): value is Ref => Predicate.isTagged(value, "ActionRef");

/** @since @next */
export const isSequence = (value: unknown): value is Sequence =>
	Predicate.isTagged(value, "Sequence");

/** @since @next */
export const isParallel = (value: unknown): value is Parallel =>
	Predicate.isTagged(value, "Parallel");
