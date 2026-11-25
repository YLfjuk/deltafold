import { Data, Effect, Predicate } from "effect";

import * as PackageConfig from "../../configs/package.ts";
import type * as Action from "../../foundation/action.ts";
import type { Occurrence } from "../../foundation/plan.ts";
import type * as Callback from "./promise-callback.ts";
import { adaptPromise } from "./promise-callback.ts";

/**
 * What a person says about manual work. There is no other answer: free-form input never
 * reaches a report.
 *
 * @since 0.2.0
 */
export type Answer = "confirmed" | "declined";

/**
 * A request to confirm manual work. The occurrence carries the action, its description,
 * and the migration instruction that declared it, which is what to show the person.
 *
 * @since 0.2.0
 */
export type Request<A extends Action.Any = Action.Any> = {
	readonly occurrence: Occurrence<A>;
};

/**
 * A Promise interaction rejected with a value that none of its declared error guards
 * recognized (`rejected`), or an interaction answered with something other than
 * `"confirmed"` or `"declined"` (`invalid-answer`). An invalid answer is never kept: it
 * may be text that the person typed.
 *
 * @since 0.2.0
 */
export class UnexpectedInteractionError extends Data.TaggedError(
	`${PackageConfig.name}/UnexpectedInteractionError`,
)<{
	readonly occurrenceId: string;
	readonly reason: "rejected" | "invalid-answer";
	/** The rejection. Always `undefined` for an invalid answer. */
	readonly cause: unknown;
}> {
	override get message() {
		return this.reason === "rejected"
			? `The interaction failed unexpectedly while confirming "${this.occurrenceId}"`
			: `The interaction answered neither "confirmed" nor "declined" for "${this.occurrenceId}"`;
	}
}

const isAnswer = (value: unknown): value is Answer => value === "confirmed" || value === "declined";

const checkAnswer = (request: Request) => (answer: unknown) =>
	isAnswer(answer)
		? Effect.succeed(answer)
		: Effect.fail(
				new UnexpectedInteractionError({
					occurrenceId: request.occurrence.id,
					reason: "invalid-answer",
					cause: undefined,
				}),
			);

const TypeId = `~${PackageConfig.name}/Interaction`;

/**
 * Asks a person to confirm the manual work of a plan. The executor has no terminal or
 * user interface of its own: the consumer running the plan supplies one of these.
 *
 * Parallel branches can ask at the same time. An interaction that owns one terminal
 * serializes its own prompts. A failure or a decline elsewhere stops new actions but
 * does not withdraw a request that was already made; only cancellation does.
 *
 * @since 0.2.0
 */
export type Interaction<out E = never, out R = never> = {
	readonly [TypeId]: typeof TypeId;
	readonly confirm: (request: Request) => Effect.Effect<Answer, E, R>;
};

/**
 * Any interaction.
 *
 * @since 0.2.0
 */
export type Any = Interaction<any, any>;

/**
 * The errors of an interaction.
 *
 * @since 0.2.0
 */
export type Error<I> = I extends Interaction<infer E, any> ? E : never;

/**
 * The Effect services of an interaction.
 *
 * @since 0.2.0
 */
export type Services<I> = I extends Interaction<any, infer R> ? R : never;

/** @since 0.2.0 */
export const isInteraction = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId);

/** @since 0.2.0 */
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
 * Confirms manual work with a Promise callback. It receives `{ signal, services }`: an
 * `AbortSignal` that aborts when the run is cancelled, so it can stop asking, and the
 * declared services.
 *
 * @example
 * ```ts
 * // The migration's instruction for this action, or the action's description.
 * const textOf = ({ action, instruction }: Plan.Occurrence) =>
 * 	instruction?.content
 * 		.map((part) => (part._tag === "Text" ? part.text : part.action.description))
 * 		.join("") ?? action.description;
 *
 * const interaction = Interaction.promise(async ({ occurrence }, { signal }) =>
 * 	(await ask(textOf(occurrence), { signal })) ? "confirmed" : "declined",
 * );
 * ```
 *
 * @since 0.2.0
 */
export const promise = <
	const S extends Callback.ServiceMap = Callback.NoServices,
	const G extends ReadonlyArray<Callback.ErrorGuard> = [],
>(
	confirm: (request: Request, context: Callback.PromiseContext<S>) => PromiseLike<Answer>,
	options?: PromiseOptions<S, G>,
): Interaction<
	Callback.GuardedError<G[number]> | UnexpectedInteractionError,
	Callback.ServiceIds<S>
> => {
	const adapt = adaptPromise(options ?? {});

	return {
		[TypeId]: TypeId,
		confirm: (request) =>
			adapt<unknown, UnexpectedInteractionError>(
				(context) => confirm(request, context),
				(cause) =>
					new UnexpectedInteractionError({
						occurrenceId: request.occurrence.id,
						reason: "rejected",
						cause,
					}),
			).pipe(Effect.flatMap(checkAnswer(request))),
	};
};

/**
 * Confirms manual work with an Effect, which keeps its own errors and services and
 * stops through Effect interruption when the run is cancelled.
 *
 * @since 0.2.0
 */
export const effect = <E = never, R = never>(
	confirm: (request: Request) => Effect.Effect<Answer, E, R>,
): Interaction<E | UnexpectedInteractionError, R> => ({
	[TypeId]: TypeId,
	confirm: (request) =>
		Effect.flatMap(
			Effect.suspend(() => confirm(request)),
			checkAnswer(request),
		),
});
