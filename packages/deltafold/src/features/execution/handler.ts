import { Data, Effect, Predicate } from "effect";

import type * as Action from "../../foundation/action.ts";
import type * as Callback from "./promise-callback.ts";
import { adaptPromise } from "./promise-callback.ts";

type NoServices = Callback.NoServices;
type ServiceIds<S extends ServiceMap> = Callback.ServiceIds<S>;
type GuardedError<G> = Callback.GuardedError<G>;
type ReservedSignal<S> = Callback.ReservedSignal<S>;

/**
 * Where a handler failure or interruption happened. A manual handler has no body: the
 * executor waits for a person in `confirmation`, then runs the handler's optional check
 * in `verification`.
 *
 * @since @next
 */
export type Phase = "precondition" | "body" | "confirmation" | "verification";

/**
 * Who performs an action: a handler body, or a person whose confirmation the executor
 * waits for.
 *
 * @since @next
 */
export type Performer = "automated" | "manual";

/**
 * A Promise handler rejected or threw a value that none of its declared error guards
 * recognized.
 *
 * @since @next
 */
export class UnexpectedHandlerError extends Data.TaggedError("UnexpectedHandlerError")<{
	readonly actionId: string;
	readonly kind: string;
	readonly phase: Phase;
	readonly cause: unknown;
}> {
	override get message() {
		return `Handler for action "${this.actionId}" failed unexpectedly in its ${this.phase}`;
	}
}

/**
 * A person confirmed manual work, and the handler's `verify` check returned `false`.
 *
 * @since @next
 */
export class VerificationFailed extends Data.TaggedError("VerificationFailed")<{
	readonly actionId: string;
	readonly kind: string;
}> {
	override get message() {
		return `Manual work for action "${this.actionId}" was confirmed, but its verification check did not pass`;
	}
}

const TypeId = "~deltafold/Handler";

/**
 * Implements one action instance. `E` and `R` are the errors and Effect services of the
 * body, precondition, and verification together.
 *
 * @since @next
 */
export type Handler<out A extends Action.Any, out E = never, out R = never> = {
	readonly [TypeId]: typeof TypeId;
	readonly action: A;
	readonly performer: Performer;
	/** Runs the action body. A manual handler has none, and the executor never runs it. */
	readonly body: Effect.Effect<void, E, R>;
	/** Decides whether the action applies. `false` skips the occurrence. */
	readonly precondition: Effect.Effect<boolean, E, R> | undefined;
	/** Checks confirmed manual work. It fails when the check does not pass. */
	readonly verification: Effect.Effect<void, E, R> | undefined;
	/** Explains a skip when the precondition returns `false`. */
	readonly skipReason: string;
};

/**
 * Any handler.
 *
 * @since @next
 */
export type Any = Handler<Action.Any, any, any>;

/**
 * The errors of a handler or a union of handlers.
 *
 * @since @next
 */
export type Error<H> = H extends Handler<any, infer E, any> ? E : never;

/**
 * The Effect services of a handler or a union of handlers.
 *
 * @since @next
 */
export type Services<H> = H extends Handler<any, any, infer R> ? R : never;

/**
 * The action identifiers implemented by a handler or a union of handlers.
 *
 * @since @next
 */
export type ActionId<H> = H extends Handler<infer A, any, any> ? A["id"] : never;

/** @since @next */
export const isHandler = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId);

type SkipReason<P> = string | ((payload: P) => string);

const skipReasonOf = <P>(action: Action.Action<string, P>, reason: SkipReason<P> | undefined) => {
	if (reason === undefined) return "Precondition returned false";

	return typeof reason === "string" ? reason : reason(action.payload);
};

/**
 * Named Effect services that a Promise handler declares.
 *
 * @since @next
 */
export type ServiceMap = Callback.ServiceMap;

/**
 * The second argument of Promise handler callbacks: the declared services, resolved,
 * and the `AbortSignal` that `Effect.tryPromise` aborts on interruption. `signal` is
 * reserved and cannot name a service.
 *
 * @since @next
 */
export type PromiseContext<S extends ServiceMap = NoServices> = Callback.PromiseContext<S>;

/**
 * Recognizes a declared rejection: a schema, or a type guard such as an `instanceof`
 * check. Guards must declare their parameter type, for example
 * `(cause: unknown): cause is NotFound => cause instanceof NotFound`.
 *
 * @since @next
 */
export type ErrorGuard = Callback.ErrorGuard;

/** @since @next */
export type PromiseOptions<P, S extends ServiceMap, G extends ReadonlyArray<ErrorGuard>> = {
	/** Effect services resolved for the callbacks and added to the handler requirements. */
	readonly services?: S;
	/**
	 * Guards for rejections that keep their own type. Other rejections become
	 * `UnexpectedHandlerError`. A guard does not prove that the callback throws only
	 * those errors.
	 */
	readonly errors?: G;
	/** Read-only precondition. Returning `false` skips the occurrence. */
	readonly when?: (payload: P, context: PromiseContext<S>) => boolean | PromiseLike<boolean>;
	readonly skipReason?: SkipReason<P>;
};

const promiseAdapter = <S extends ServiceMap, G extends ReadonlyArray<ErrorGuard>>(
	action: Action.Any,
	options: { readonly services?: S | undefined; readonly errors?: G | undefined },
) => {
	const adapt = adaptPromise(options);

	return <T>(phase: Phase, callback: (context: PromiseContext<S>) => PromiseLike<T> | T) =>
		adapt(
			callback,
			(cause) =>
				new UnexpectedHandlerError({
					actionId: action.id,
					kind: action.kind,
					phase,
					cause,
				}),
		);
};

/**
 * Implements an action with Promise callbacks. The callbacks run lazily through
 * `Effect.tryPromise`, and receive declared services and its `AbortSignal` in their
 * second argument.
 *
 * @example
 * ```ts
 * Handler.promise(
 * 	updateRemoteConfig,
 * 	async (payload, { signal, editor }) => {
 * 		await editor.update(payload, { signal });
 * 	},
 * 	{ services: { editor: ConfigEditor } },
 * );
 * ```
 *
 * @since @next
 */
export const promise = <
	A extends Action.Any,
	const S extends ServiceMap = NoServices,
	const G extends ReadonlyArray<ErrorGuard> = [],
>(
	action: A,
	run: (payload: A["payload"], context: PromiseContext<S>) => PromiseLike<unknown>,
	options?: PromiseOptions<A["payload"], S, G> & ReservedSignal<S>,
): Handler<A, GuardedError<G[number]> | UnexpectedHandlerError, ServiceIds<S>> => {
	const adapt = promiseAdapter(action, options ?? {});
	const when = options?.when;

	return {
		[TypeId]: TypeId,
		action,
		performer: "automated",
		body: Effect.asVoid(adapt("body", (context) => run(action.payload, context))),
		precondition:
			when === undefined
				? undefined
				: adapt("precondition", (context) => when(action.payload, context)),
		verification: undefined,
		skipReason: skipReasonOf(action, options?.skipReason),
	};
};

/** @since @next */
export type EffectOptions<P, E, R> = {
	/** Read-only precondition. Succeeding with `false` skips the occurrence. */
	readonly when?: (payload: P) => Effect.Effect<boolean, E, R>;
	readonly skipReason?: SkipReason<P>;
};

/**
 * Implements an action with an Effect. The body keeps its own errors and services, and
 * stops through native Effect interruption.
 *
 * @since @next
 */
export const effect = <A extends Action.Any, E = never, R = never, E2 = never, R2 = never>(
	action: A,
	run: (payload: A["payload"]) => Effect.Effect<unknown, E, R>,
	options: EffectOptions<A["payload"], E2, R2> = {},
): Handler<A, E | E2, R | R2> => {
	const when = options.when;

	return {
		[TypeId]: TypeId,
		action,
		performer: "automated",
		body: Effect.asVoid(Effect.suspend(() => run(action.payload))),
		precondition: when === undefined ? undefined : Effect.suspend(() => when(action.payload)),
		verification: undefined,
		skipReason: skipReasonOf(action, options.skipReason),
	};
};

const verified = <E, R>(action: Action.Any, check: Effect.Effect<boolean, E, R>) =>
	Effect.flatMap(check, (passed) =>
		passed
			? Effect.void
			: Effect.fail(new VerificationFailed({ actionId: action.id, kind: action.kind })),
	);

/** @since @next */
export type ManualOptions<P, S extends ServiceMap, G extends ReadonlyArray<ErrorGuard>> = {
	/** Effect services resolved for the callbacks and added to the handler requirements. */
	readonly services?: S;
	/** Guards for rejections of `when` and `verify` that keep their own type. */
	readonly errors?: G;
	/** Read-only precondition. Returning `false` skips the occurrence without asking. */
	readonly when?: (payload: P, context: PromiseContext<S>) => boolean | PromiseLike<boolean>;
	readonly skipReason?: SkipReason<P>;
	/**
	 * Read-only check that runs after the person confirms. Returning `false` fails the
	 * occurrence with `VerificationFailed`. A passing check is evidence that the work is
	 * in place, not proof of how it was done.
	 */
	readonly verify?: (payload: P, context: PromiseContext<S>) => boolean | PromiseLike<boolean>;
};

// An optional `verify` key may hold a check, so it counts as declared.
type VerifyError<O> = "verify" extends keyof O ? VerificationFailed : never;

type ManualErrors<O, G extends ReadonlyArray<ErrorGuard>> =
	| ("when" extends keyof O
			? GuardedError<G[number]> | UnexpectedHandlerError
			: "verify" extends keyof O
				? GuardedError<G[number]> | UnexpectedHandlerError
				: never)
	| VerifyError<O>;

/**
 * Declares that a person performs the action. The executor asks its `interaction` to
 * confirm the work, showing the occurrence's own instruction or description, and never
 * completes the occurrence on its own. The optional `when` and `verify` checks are
 * Promise callbacks, as in `Handler.promise`.
 *
 * The same action can have a manual handler in one environment and an automated one in
 * another.
 *
 * @example
 * ```ts
 * Handler.manual(rotateApiKey, {
 * 	services: { keys: KeyStore },
 * 	verify: (payload, { keys }) => keys.isFresh(payload.service),
 * });
 * ```
 *
 * @since @next
 */
export const manual = <
	A extends Action.Any,
	const S extends ServiceMap = NoServices,
	const G extends ReadonlyArray<ErrorGuard> = [],
	const O extends ManualOptions<A["payload"], S, G> = NoServices,
>(
	action: A,
	options?: O & ManualOptions<A["payload"], S, G> & ReservedSignal<S>,
): Handler<A, ManualErrors<O, G>, ServiceIds<S>> => {
	const adapt = promiseAdapter(action, options ?? {});
	const when = options?.when;
	const verify = options?.verify;

	// `ManualErrors` narrows the errors to the checks that the options declare.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return {
		[TypeId]: TypeId,
		action,
		performer: "manual",
		body: Effect.void,
		precondition:
			when === undefined
				? undefined
				: adapt("precondition", (context) => when(action.payload, context)),
		verification:
			verify === undefined
				? undefined
				: verified(
						action,
						adapt("verification", (context) => verify(action.payload, context)),
					),
		skipReason: skipReasonOf(action, options?.skipReason),
	} as Handler<A, ManualErrors<O, G>, ServiceIds<S>>;
};

/** @since @next */
export type ManualEffectOptions<P, E, R, E2, R2> = {
	/** Read-only precondition. Succeeding with `false` skips the occurrence without asking. */
	readonly when?: (payload: P) => Effect.Effect<boolean, E, R>;
	readonly skipReason?: SkipReason<P>;
	/**
	 * Read-only check that runs after the person confirms. Succeeding with `false` fails
	 * the occurrence with `VerificationFailed`.
	 */
	readonly verify?: (payload: P) => Effect.Effect<boolean, E2, R2>;
};

/**
 * `Handler.manual` with Effect checks, which keep their own errors and services.
 *
 * @since @next
 */
export const manualEffect = <
	A extends Action.Any,
	E = never,
	R = never,
	E2 = never,
	R2 = never,
	const O extends ManualEffectOptions<A["payload"], E, R, E2, R2> = NoServices,
>(
	action: A,
	options?: O & ManualEffectOptions<A["payload"], E, R, E2, R2>,
): Handler<A, E | E2 | VerifyError<O>, R | R2> => {
	const when = options?.when;
	const verify = options?.verify;

	// `VerifyError` adds `VerificationFailed` only when `verify` is declared.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return {
		[TypeId]: TypeId,
		action,
		performer: "manual",
		body: Effect.void,
		precondition: when === undefined ? undefined : Effect.suspend(() => when(action.payload)),
		verification:
			verify === undefined
				? undefined
				: verified(
						action,
						Effect.suspend(() => verify(action.payload)),
					),
		skipReason: skipReasonOf(action, options?.skipReason),
	} as Handler<A, E | E2 | VerifyError<O>, R | R2>;
};
