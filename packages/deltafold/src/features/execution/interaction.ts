import { Data, Effect, Predicate } from "effect";

import type * as Action from "../../foundation/action.ts";
import type { Occurrence } from "../../foundation/plan.ts";
import type * as Callback from "./promise-callback.ts";
import { adaptPromise } from "./promise-callback.ts";

/**
 * What a person says about manual work. There is no other answer: free-form input never
 * reaches a report.
 *
 * @since @next
 */
export type Answer = "confirmed" | "declined";

/**
 * A request to confirm manual work. The occurrence carries the action, its description,
 * and the migration instruction that declared it, which is what to show the person.
 *
 * @since @next
 */
export type Request<A extends Action.Any = Action.Any> = {
	readonly occurrence: Occurrence<A>;
};

/**
 * A Promise interaction rejected with a value that none of its declared error guards
 * recognized, or an interaction answered with something other than `"confirmed"` or
 * `"declined"`.
 *
 * @since @next
 */
export class UnexpectedInteractionError extends Data.TaggedError("UnexpectedInteractionError")<{
	readonly occurrenceId: string;
	readonly cause: unknown;
}> {
	override get message() {
		return `The interaction failed unexpectedly while confirming "${this.occurrenceId}"`;
	}
}

const TypeId = "~deltafold/Interaction";

/**
 * Asks a person to confirm the manual work of a plan. The executor has no terminal or
 * user interface of its own: the consumer running the plan supplies one of these.
 *
 * Parallel branches can ask at the same time. An interaction that owns one terminal
 * serializes its own prompts.
 *
 * @since @next
 */
export type Interaction<out E = never, out R = never> = {
	readonly [TypeId]: typeof TypeId;
	readonly confirm: (request: Request) => Effect.Effect<Answer, E, R>;
};

/**
 * Any interaction.
 *
 * @since @next
 */
export type Any = Interaction<any, any>;

/**
 * The errors of an interaction.
 *
 * @since @next
 */
export type Error<I> = I extends Interaction<infer E, any> ? E : never;

/**
 * The Effect services of an interaction.
 *
 * @since @next
 */
export type Services<I> = I extends Interaction<any, infer R> ? R : never;

/** @since @next */
export const isInteraction = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId);

const isAnswer = (value: unknown): value is Answer => value === "confirmed" || value === "declined";

/** @since @next */
export type PromiseOptions<
	S extends Callback.ServiceMap,
	G extends ReadonlyArray<Callback.ErrorGuard>,
> = {
	/** Effect services resolved for the callback and added to the run's requirements. */
	readonly services?: S;
	/** Guards for rejections that keep their own type. */
	readonly errors?: G;
};

/**
 * Confirms manual work with a Promise callback. It receives declared services and an
 * `AbortSignal` that aborts when the run is cancelled, so it can stop asking.
 *
 * @example
 * ```ts
 * const interaction = Interaction.promise(async ({ occurrence }, { signal }) =>
 * 	(await ask(occurrence.action.description, { signal })) ? "confirmed" : "declined",
 * );
 * ```
 *
 * @since @next
 */
export const promise = <
	const S extends Callback.ServiceMap = Callback.NoServices,
	const G extends ReadonlyArray<Callback.ErrorGuard> = [],
>(
	confirm: (request: Request, context: Callback.PromiseContext<S>) => PromiseLike<Answer>,
	options?: PromiseOptions<S, G> & Callback.ReservedSignal<S>,
): Interaction<
	Callback.GuardedError<G[number]> | UnexpectedInteractionError,
	Callback.ServiceIds<S>
> => {
	const adapt = adaptPromise(options ?? {});

	return {
		[TypeId]: TypeId,
		confirm: (request) => {
			const unexpected = (cause: unknown) =>
				new UnexpectedInteractionError({ occurrenceId: request.occurrence.id, cause });

			return adapt<unknown, UnexpectedInteractionError>(
				(context) => confirm(request, context),
				unexpected,
			).pipe(
				Effect.flatMap((answer) =>
					isAnswer(answer) ? Effect.succeed(answer) : Effect.fail(unexpected(answer)),
				),
			);
		},
	};
};

/**
 * Confirms manual work with an Effect, which keeps its own errors and services and
 * stops through Effect interruption when the run is cancelled.
 *
 * @since @next
 */
export const effect = <E = never, R = never>(
	confirm: (request: Request) => Effect.Effect<Answer, E, R>,
): Interaction<E, R> => ({
	[TypeId]: TypeId,
	confirm: (request) =>
		Effect.flatMap(
			Effect.suspend(() => confirm(request)),
			(answer) =>
				isAnswer(answer)
					? Effect.succeed(answer)
					: Effect.die(
							new UnexpectedInteractionError({
								occurrenceId: request.occurrence.id,
								cause: answer,
							}),
						),
		),
});
