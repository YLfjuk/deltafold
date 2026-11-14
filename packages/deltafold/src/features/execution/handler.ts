import { Data, Effect, Predicate, Scope } from "effect";

import type * as Action from "../../foundation/action.ts";
import type * as Callback from "./promise-callback.ts";
import { adaptPromise } from "./promise-callback.ts";

type NoServices = Callback.NoServices;
type ServiceIds<S extends ServiceMap> = Callback.ServiceIds<S>;
type GuardedError<G> = Callback.GuardedError<G>;

/**
 * Where a handler failure or interruption happened: the read-only prepare phase, or the
 * apply phase that changes state. A manual handler has neither: the executor waits for a
 * person in `confirmation`, then runs the handler's optional check in `verification`.
 *
 * @since @next
 */
export type Phase = "prepare" | "apply" | "confirmation" | "verification";

/**
 * Who performs an action: a handler's apply phase, or a person whose confirmation the
 * executor waits for.
 *
 * @since @next
 */
export type Performer = "automated" | "manual";

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

/**
 * A Promise handler rejected or threw a value that none of its declared error guards
 * recognized, or its prepare phase returned something other than `Handler.prepared` or
 * `Handler.skip`.
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
		return `Handler for action "${this.actionId}" failed unexpectedly in its ${this.phase} phase`;
	}
}

const PreparationTypeId = "~deltafold/Preparation";

/**
 * A prepare phase decided to apply. The apply phase receives `value` unchanged; the
 * executor never reads, validates, or serializes it.
 *
 * @since @next
 */
export type Prepared<out P> = {
	readonly [PreparationTypeId]: typeof PreparationTypeId;
	readonly _tag: "Prepared";
	readonly value: P;
};

/**
 * A prepare phase decided that the action does not apply. The occurrence is skipped
 * with `reason`.
 *
 * @since @next
 */
export type Skip = {
	readonly [PreparationTypeId]: typeof PreparationTypeId;
	readonly _tag: "Skip";
	readonly reason: string;
};

/**
 * What a prepare phase returns: `Handler.prepared(value)` or `Handler.skip(reason)`.
 *
 * @since @next
 */
export type Preparation<P> = Prepared<P> | Skip;

/** The value that a prepare phase passes to its apply phase. */
type PreparedValue<T> = T extends Prepared<infer P> ? P : never;

/**
 * Ends a prepare phase with the value its apply phase receives. Wrapping the value keeps
 * it apart from a skip, whatever its shape.
 *
 * @since @next
 */
export function prepared(): Prepared<void>;
export function prepared<P>(value: P): Prepared<P>;
export function prepared(value?: unknown): Prepared<unknown> {
	return { [PreparationTypeId]: PreparationTypeId, _tag: "Prepared", value };
}

/**
 * Ends a prepare phase by skipping the occurrence. The apply phase does not run.
 *
 * @since @next
 */
export const skip = (reason: string): Skip => ({
	[PreparationTypeId]: PreparationTypeId,
	_tag: "Skip",
	reason,
});

const isPreparation = (value: unknown): value is Preparation<unknown> =>
	Predicate.hasProperty(value, PreparationTypeId);

const notAPreparation = () =>
	new TypeError("A prepare phase must return Handler.prepared(value) or Handler.skip(reason)");

/**
 * How an occurrence continues after its prepare phase: skipped, applied by an effect
 * that already holds the prepared value, or confirmed by a person. `verify` checks
 * confirmed work and fails when the check does not pass.
 *
 * @since @next
 */
export type Step<E, R> =
	| Skip
	| { readonly _tag: "Apply"; readonly apply: Effect.Effect<void, E, R> }
	| { readonly _tag: "Confirm"; readonly verify: Effect.Effect<void, E, R> | undefined };

const applyStep = <E, R>(apply: Effect.Effect<void, E, R>): Step<E, R> => ({
	_tag: "Apply",
	apply,
});

const TypeId = "~deltafold/Handler";

/**
 * Implements one action instance. `E` and `R` are the errors and Effect services of both
 * phases together. A prepared value stays inside the handler, so handlers with
 * different prepared values share this type.
 *
 * @since @next
 */
export type Handler<out A extends Action.Any, out E = never, out R = never> = {
	readonly [TypeId]: typeof TypeId;
	readonly action: A;
	/** A `manual` handler has no phases of its own: a person does the work. */
	readonly performer: Performer;
	/** Whether the handler has a prepare phase. */
	readonly prepares: boolean;
	/**
	 * Runs the prepare phase, if any, and resolves to the next step. Both phases share
	 * `scope`, the occurrence's scope, so resources acquired while preparing stay open
	 * until the executor closes it after the occurrence ends.
	 */
	readonly prepare: (scope: Scope.Scope) => Effect.Effect<Step<E, R>, E, R>;
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

const make = <A extends Action.Any, E, R>(
	action: A,
	prepares: boolean,
	prepare: (scope: Scope.Scope) => Effect.Effect<Step<E, R>, E, R>,
): Handler<A, E, R> => ({ [TypeId]: TypeId, action, performer: "automated", prepares, prepare });

/**
 * Named Effect services that a Promise handler declares.
 *
 * @since @next
 */
export type ServiceMap = Callback.ServiceMap;

/**
 * The second argument of Promise handler callbacks: the `AbortSignal` that
 * `Effect.tryPromise` aborts on interruption, and the declared services, resolved.
 *
 * @since @next
 */
export type PromiseContext<S extends ServiceMap = NoServices> = Callback.PromiseContext<S>;

/**
 * The second argument of a Promise apply phase: the Promise context and the action
 * payload.
 *
 * @since @next
 */
export type PromiseApplyContext<Payload, S extends ServiceMap = NoServices> = PromiseContext<S> & {
	readonly payload: Payload;
};

/**
 * A Promise handler with a prepare phase. `prepare` reads state and returns
 * `Handler.prepared(value)` or `Handler.skip(reason)`; `apply` receives the value. Each
 * phase gets its own signal.
 *
 * @since @next
 */
export type PromisePhases<Payload, T extends Preparation<unknown>, S extends ServiceMap> = {
	readonly prepare: (payload: Payload, context: PromiseContext<S>) => PromiseLike<T> | T;
	readonly apply: (
		prepared: PreparedValue<T>,
		context: PromiseApplyContext<Payload, S>,
	) => PromiseLike<unknown>;
};

/**
 * Recognizes a declared rejection: a schema, or a type guard such as an `instanceof`
 * check. Guards must declare their parameter type, for example
 * `(cause: unknown): cause is NotFound => cause instanceof NotFound`.
 *
 * @since @next
 */
export type ErrorGuard = Callback.ErrorGuard;

/** @since @next */
export type PromiseOptions<S extends ServiceMap, G extends ReadonlyArray<ErrorGuard>> = {
	/** Effect services resolved for the callbacks and added to the handler requirements. */
	readonly services?: S;
	/**
	 * Guards for rejections that keep their own type. Other rejections become
	 * `UnexpectedHandlerError`. A guard does not prove that the callback throws only
	 * those errors.
	 */
	readonly errors?: G;
};

type PromiseHandler<A extends Action.Any, S extends ServiceMap, G> = Handler<
	A,
	GuardedError<G> | UnexpectedHandlerError,
	ServiceIds<S>
>;

/**
 * Implements an action with Promise callbacks. The callbacks run lazily through
 * `Effect.tryPromise`, and receive its `AbortSignal` and the declared services.
 *
 * Pass one callback to apply the action directly, or `{ prepare, apply }` to decide
 * first. `prepare` must only read: a dry run calls it and never calls `apply`. A real
 * run calls `apply` once with the prepared value.
 *
 * @example
 * ```ts
 * Handler.promise(
 * 	updateRemoteConfig,
 * 	async (payload, { signal, services: { editor } }) => {
 * 		await editor.update(payload, { signal });
 * 	},
 * 	{ services: { editor: ConfigEditor } },
 * );
 * ```
 *
 * @example
 * ```ts
 * Handler.promise(renameTimeout, {
 * 	prepare: async ({ file, from }, { signal }) => {
 * 		const config = await readConfig(file, { signal });
 * 		return from in config ? Handler.prepared(config) : Handler.skip(`${file} has no ${from}`);
 * 	},
 * 	apply: async (config, { payload, signal }) => {
 * 		await writeConfig(payload.file, rename(config, payload), { signal });
 * 	},
 * });
 * ```
 *
 * @since @next
 */
export function promise<
	A extends Action.Any,
	const S extends ServiceMap = NoServices,
	const G extends ReadonlyArray<ErrorGuard> = [],
>(
	action: A,
	apply: (payload: A["payload"], context: PromiseContext<S>) => PromiseLike<unknown>,
	options?: PromiseOptions<S, G>,
): PromiseHandler<A, S, G[number]>;
export function promise<
	A extends Action.Any,
	T extends Preparation<unknown> = Skip,
	const S extends ServiceMap = NoServices,
	const G extends ReadonlyArray<ErrorGuard> = [],
>(
	action: A,
	phases: PromisePhases<A["payload"], T, S>,
	options?: PromiseOptions<S, G>,
): PromiseHandler<A, S, G[number]>;
export function promise<
	A extends Action.Any,
	S extends ServiceMap,
	G extends ReadonlyArray<ErrorGuard>,
>(
	action: A,
	run:
		| ((payload: A["payload"], context: PromiseContext<S>) => PromiseLike<unknown>)
		| PromisePhases<A["payload"], Preparation<unknown>, S>,
	options?: PromiseOptions<S, G>,
): PromiseHandler<A, S, G[number]> {
	type E = GuardedError<G[number]> | UnexpectedHandlerError;

	const adaptCallback = adaptPromise(options ?? {});
	const unexpected = (phase: Phase, cause: unknown) =>
		new UnexpectedHandlerError({ actionId: action.id, kind: action.kind, phase, cause });

	const adapt = <T>(
		phase: Phase,
		callback: (context: PromiseContext<S>) => PromiseLike<T> | T,
	): Effect.Effect<T, E, ServiceIds<S>> =>
		adaptCallback(callback, (cause) => unexpected(phase, cause));

	if (Predicate.isFunction(run)) {
		const apply = Effect.asVoid(adapt("apply", (context) => run(action.payload, context)));

		return make(action, false, () => Effect.succeed(applyStep(apply)));
	}

	const prepare = adapt("prepare", (context) => run.prepare(action.payload, context)).pipe(
		Effect.filterOrFail(isPreparation, () => unexpected("prepare", notAPreparation())),
		Effect.map((preparation): Step<E, ServiceIds<S>> =>
			preparation._tag === "Skip"
				? preparation
				: applyStep(
						Effect.asVoid(
							adapt("apply", (context) =>
								run.apply(preparation.value, {
									...context,
									payload: action.payload,
								}),
							),
						),
					),
		),
	);

	return make(action, true, () => prepare);
}

/**
 * The second argument of an Effect apply phase.
 *
 * @since @next
 */
export type EffectApplyContext<Payload> = { readonly payload: Payload };

/**
 * An Effect handler with a prepare phase. `prepare` reads state and succeeds with
 * `Handler.prepared(value)` or `Handler.skip(reason)`; `apply` receives the value.
 *
 * @since @next
 */
export type EffectPhases<Payload, T extends Preparation<unknown>, E1, R1, E2, R2> = {
	readonly prepare: (payload: Payload) => Effect.Effect<T, E1, R1>;
	readonly apply: (
		prepared: PreparedValue<T>,
		context: EffectApplyContext<Payload>,
	) => Effect.Effect<unknown, E2, R2>;
};

/**
 * Implements an action with an Effect. The handler keeps its own errors and services,
 * and stops through native Effect interruption.
 *
 * Pass one function to apply the action directly, or `{ prepare, apply }` to decide
 * first. `prepare` must only read: a dry run runs it and never runs `apply`. A real run
 * runs `apply` once with the prepared value. Both phases run in the occurrence's
 * `Scope`, so a resource acquired while preparing, such as a lock, stays open until the
 * occurrence ends; the handler does not require `Scope`.
 *
 * @example
 * ```ts
 * Handler.effect(renameTimeout, {
 * 	prepare: ({ file, from }) =>
 * 		Effect.gen(function* () {
 * 			const files = yield* ConfigFiles;
 * 			const config = yield* files.lock(file);
 * 			return from in config.data ? Handler.prepared(config) : Handler.skip(`${file} has no ${from}`);
 * 		}),
 * 	apply: (config, { payload }) => config.write(rename(config.data, payload)),
 * });
 * ```
 *
 * @since @next
 */
export function effect<A extends Action.Any, E = never, R = never>(
	action: A,
	apply: (payload: A["payload"]) => Effect.Effect<unknown, E, R>,
): Handler<A, E, Exclude<R, Scope.Scope>>;
export function effect<
	A extends Action.Any,
	T extends Preparation<unknown> = Skip,
	E1 = never,
	R1 = never,
	E2 = never,
	R2 = never,
>(
	action: A,
	phases: EffectPhases<A["payload"], T, E1, R1, E2, R2>,
): Handler<A, E1 | E2, Exclude<R1 | R2, Scope.Scope>>;
export function effect<A extends Action.Any, E1, R1, E2, R2>(
	action: A,
	run:
		| ((payload: A["payload"]) => Effect.Effect<unknown, E1, R1>)
		| EffectPhases<A["payload"], Preparation<unknown>, E1, R1, E2, R2>,
): Handler<A, E1 | E2, Exclude<R1 | R2, Scope.Scope>> {
	type E = E1 | E2;
	type R = Exclude<R1 | R2, Scope.Scope>;

	if (Predicate.isFunction(run)) {
		const apply = Effect.asVoid(Effect.suspend(() => run(action.payload)));

		return make(action, false, (scope) =>
			Effect.succeed(applyStep<E, R>(Scope.provide(apply, scope))),
		);
	}

	return make(action, true, (scope) =>
		Effect.suspend(() => run.prepare(action.payload)).pipe(
			Scope.provide(scope),
			Effect.filterOrElse(isPreparation, () => Effect.die(notAPreparation())),
			Effect.map((preparation): Step<E, R> =>
				preparation._tag === "Skip"
					? preparation
					: applyStep(
							Scope.provide(
								Effect.asVoid(
									Effect.suspend(() =>
										run.apply(preparation.value, { payload: action.payload }),
									),
								),
								scope,
							),
						),
			),
		),
	);
}

const verified = <E, R>(action: Action.Any, check: Effect.Effect<boolean, E, R>) =>
	Effect.flatMap(check, (passed) =>
		passed
			? Effect.void
			: Effect.fail(new VerificationFailed({ actionId: action.id, kind: action.kind })),
	);

const makeManual = <A extends Action.Any, E, R>(
	action: A,
	verify: ((scope: Scope.Scope) => Effect.Effect<void, E, R>) | undefined,
): Handler<A, E, R> => ({
	[TypeId]: TypeId,
	action,
	performer: "manual",
	prepares: false,
	prepare: (scope) => Effect.succeed({ _tag: "Confirm", verify: verify?.(scope) }),
});

/** @since @next */
export type ManualOptions<Payload, S extends ServiceMap, G extends ReadonlyArray<ErrorGuard>> = {
	/** Effect services resolved for `verify` and added to the handler requirements. */
	readonly services?: S;
	/** Guards for rejections of `verify` that keep their own type. */
	readonly errors?: G;
	/**
	 * Read-only check that runs after the person confirms. Returning `false` fails the
	 * occurrence with `VerificationFailed`. A passing check is evidence that the work is
	 * in place, not proof of how it was done.
	 */
	readonly verify?: (
		payload: Payload,
		context: PromiseContext<S>,
	) => boolean | PromiseLike<boolean>;
};

// An optional `verify` key may hold a check, so it counts as declared.
type ManualErrors<O, G extends ReadonlyArray<ErrorGuard>> = "verify" extends keyof O
	? GuardedError<G[number]> | UnexpectedHandlerError | VerificationFailed
	: never;

/**
 * Declares that a person performs the action. A manual handler has no prepare or apply
 * phase. In a real run the executor asks its `interaction` to confirm the work, showing
 * the occurrence's own instruction or description, and never completes the occurrence
 * on its own. A dry run reports that a person would be asked. The optional `verify`
 * check is a Promise callback that runs only after the confirmation.
 *
 * The same action can have a manual handler in one environment and an automated one in
 * another.
 *
 * @example
 * ```ts
 * Handler.manual(rotateApiKey, {
 * 	services: { keys: KeyStore },
 * 	verify: (payload, { services: { keys } }) => keys.isFresh(payload.service),
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
	options?: O & ManualOptions<A["payload"], S, G>,
): Handler<A, ManualErrors<O, G>, ServiceIds<S>> => {
	const adapt = adaptPromise(options ?? {});
	const verify = options?.verify;
	const check =
		verify === undefined
			? undefined
			: verified(
					action,
					adapt(
						(context) => verify(action.payload, context),
						(cause) =>
							new UnexpectedHandlerError({
								actionId: action.id,
								kind: action.kind,
								phase: "verification",
								cause,
							}),
					),
				);

	// `ManualErrors` is `never` only when the options cannot hold a check, and then
	// `check` is undefined and the handler has no errors.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return makeManual(action, check === undefined ? undefined : () => check) as Handler<
		A,
		ManualErrors<O, G>,
		ServiceIds<S>
	>;
};

/** @since @next */
export type ManualEffectOptions<Payload, E, R> = {
	/**
	 * Read-only check that runs after the person confirms. Succeeding with `false` fails
	 * the occurrence with `VerificationFailed`. It runs in the occurrence's `Scope`.
	 */
	readonly verify?: (payload: Payload) => Effect.Effect<boolean, E, R>;
};

type VerifyError<O> = "verify" extends keyof O ? VerificationFailed : never;

/**
 * `Handler.manual` with an Effect `verify` check, which keeps its own errors and
 * services.
 *
 * @since @next
 */
export const manualEffect = <
	A extends Action.Any,
	E = never,
	R = never,
	const O extends ManualEffectOptions<A["payload"], E, R> = NoServices,
>(
	action: A,
	options?: O & ManualEffectOptions<A["payload"], E, R>,
): Handler<A, E | VerifyError<O>, Exclude<R, Scope.Scope>> => {
	const verify = options?.verify;

	// `VerifyError` is `never` only when the options cannot hold a check.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return makeManual(
		action,
		verify === undefined
			? undefined
			: (scope) =>
					Scope.provide(
						verified(
							action,
							Effect.suspend(() => verify(action.payload)),
						),
						scope,
					),
	) as Handler<A, E | VerifyError<O>, Exclude<R, Scope.Scope>>;
};
