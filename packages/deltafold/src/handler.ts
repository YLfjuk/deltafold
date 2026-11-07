/**
 * Handlers implement action instances. `Handler.promise` adapts Promise callbacks and
 * `Handler.effect` accepts native Effect callbacks. Both produce the same public
 * `Handler` value, which integrations can also return from their own factories.
 *
 * @packageDocumentation
 */
import { Context, Data, Effect, Layer, Predicate, Schema } from "effect";

import type * as Action from "./action.ts";
import { trackPromise } from "./internal/settlement.ts";

/** Where a handler failure happened. */
export type Phase = "precondition" | "body";

/**
 * A Promise handler rejected or threw a value that none of its declared error guards
 * recognized.
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
 * A handler supplied through `Handler.layer` failed. Layer bindings are looked up by
 * action identifier at run time, so their declared error types are not visible to the
 * executor. The original error is kept in `cause`.
 */
export class BoundHandlerError extends Data.TaggedError("BoundHandlerError")<{
	readonly actionId: string;
	readonly cause: unknown;
}> {
	override get message() {
		return `Handler bound for action "${this.actionId}" failed`;
	}
}

const TypeId = "~deltafold/Handler";

/**
 * Implements one action instance. `E` and `R` are the errors and Effect services of the
 * body and precondition together.
 */
export type Handler<out A extends Action.Any, out E = never, out R = never> = {
	readonly [TypeId]: typeof TypeId;
	readonly action: A;
	/** Runs the action body. */
	readonly body: Effect.Effect<void, E, R>;
	/** Decides whether the body applies. `false` skips the occurrence. */
	readonly precondition: Effect.Effect<boolean, E, R> | undefined;
	/** Explains a skip when the precondition returns `false`. */
	readonly skipReason: string;
};

/** Any handler. */
export type Any = Handler<Action.Any, any, any>;

/** The errors of a handler or a union of handlers. */
export type Error<H> = H extends Handler<any, infer E, any> ? E : never;

/** The Effect services of a handler or a union of handlers. */
export type Services<H> = H extends Handler<any, any, infer R> ? R : never;

/** The action identifiers implemented by a handler or a union of handlers. */
export type ActionId<H> = H extends Handler<infer A, any, any> ? A["id"] : never;

export const isHandler = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId);

type SkipReason<P> = string | ((payload: P) => string);

const skipReasonOf = <P>(action: Action.Action<string, P>, reason: SkipReason<P> | undefined) => {
	if (reason === undefined) return "Precondition returned false";

	return typeof reason === "string" ? reason : reason(action.payload);
};

/** Named Effect services that a Promise handler declares. */
export type ServiceMap = { readonly [name: string]: Context.Key<any, any> };

// oxlint-disable-next-line typescript/no-generated-empty-object-type -- A handler without services declares an empty service map.
type NoServices = Record<never, never>;

/**
 * The second argument of Promise handler callbacks: the declared services, resolved,
 * and the `AbortSignal` that `Effect.tryPromise` aborts on interruption. `signal` is
 * reserved and cannot name a service.
 */
export type PromiseContext<S extends ServiceMap = NoServices> = {
	readonly [K in keyof S]: S[K]["Service"];
} & { readonly signal: AbortSignal };

type ServiceIds<S extends ServiceMap> = {
	[K in keyof S]: S[K] extends Context.Key<infer I, any> ? I : never;
}[keyof S];

/**
 * Recognizes a declared rejection: a schema, or a type guard such as an `instanceof`
 * check. Guards must declare their parameter type, for example
 * `(cause: unknown): cause is NotFound => cause instanceof NotFound`.
 */
export type ErrorGuard = Schema.Top | ((cause: unknown) => cause is any);

type GuardedError<G> = G extends Schema.Top
	? G["Type"]
	: G extends ((cause: unknown) => cause is infer E)
		? E
		: never;

/** Rejects a service named `signal`, which is reserved for the AbortSignal. */
type ReservedSignal<S> = "signal" extends keyof S
	? {
			readonly services: {
				readonly [K in keyof S]: K extends "signal"
					? "`signal` is reserved for the AbortSignal"
					: S[K];
			};
		}
	: unknown;

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

const declaredError =
	<G extends ReadonlyArray<ErrorGuard>>(guards: G) =>
	(cause: unknown): cause is GuardedError<G[number]> =>
		guards.some((guard) => (Schema.isSchema(guard) ? Schema.is(guard)(cause) : guard(cause)));

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
	const isDeclared = declaredError(options?.errors ?? []);
	// Effect.all resolves each declared key to its service. TypeScript cannot relate its
	// conditional record type to the mapped context type while `S` is generic.
	const services: ServiceMap = options?.services ?? {};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const resolve = Effect.all(services) as Effect.Effect<
		{ readonly [K in keyof S]: S[K]["Service"] },
		never,
		ServiceIds<S>
	>;

	const adapt = <T>(
		phase: Phase,
		callback: (context: PromiseContext<S>) => PromiseLike<T> | T,
	): Effect.Effect<T, GuardedError<G[number]> | UnexpectedHandlerError, ServiceIds<S>> =>
		Effect.flatMap(resolve, (resolved) =>
			trackPromise((capture) =>
				Effect.tryPromise({
					// Declaring `signal` makes Effect.tryPromise allocate an AbortController.
					try: (signal) => capture(Promise.resolve(callback({ ...resolved, signal }))),
					catch: (cause) =>
						isDeclared(cause)
							? cause
							: new UnexpectedHandlerError({
									actionId: action.id,
									kind: action.kind,
									phase,
									cause,
								}),
				}),
			),
		);

	const when = options?.when;

	return {
		[TypeId]: TypeId,
		action,
		body: Effect.asVoid(adapt("body", (context) => run(action.payload, context))),
		precondition:
			when === undefined
				? undefined
				: adapt("precondition", (context) => when(action.payload, context)),
		skipReason: skipReasonOf(action, options?.skipReason),
	};
};

export type EffectOptions<P, E, R> = {
	/** Read-only precondition. Succeeding with `false` skips the occurrence. */
	readonly when?: (payload: P) => Effect.Effect<boolean, E, R>;
	readonly skipReason?: SkipReason<P>;
};

/**
 * Implements an action with an Effect. The body keeps its own errors and services, and
 * stops through native Effect interruption.
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
		body: Effect.asVoid(Effect.suspend(() => run(action.payload))),
		precondition: when === undefined ? undefined : Effect.suspend(() => when(action.payload)),
		skipReason: skipReasonOf(action, options.skipReason),
	};
};

/** The Effect service that holds the handler bound to one action identifier. */
export type Binding<Id extends string> = {
	readonly _tag: "deltafold/Handler.Binding";
	readonly actionId: Id;
};

type BoundHandler = Handler<Action.Any, BoundHandlerError>;

const bindingPrefix = "deltafold/Handler.Binding/";

/** The context key for the handler bound to `actionId`. */
export const bindingKey = <Id extends string>(actionId: Id) =>
	Context.Service<Binding<Id>, BoundHandler>(`${bindingPrefix}${actionId}`);

/** Looks up a bound handler in a context by action identifier. */
export const findBinding = (
	context: Context.Context<never>,
	actionId: string,
): BoundHandler | undefined => Context.getOrUndefined(context, bindingKey(actionId));

/**
 * Provides handlers as Effect services. The layer requires the handlers' own services
 * and captures them when it is built, so executors see only `Binding` requirements.
 */
export const layer = <const H extends ReadonlyArray<Any>>(
	handlers: H,
): Layer.Layer<Binding<ActionId<H[number]>>, never, Services<H[number]>> =>
	Layer.effectContext(
		Effect.map(Effect.context<Services<H[number]>>(), (context) => {
			// Each handler adds its own binding. The loop cannot express that the result holds
			// one binding per element of `H`.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			let bindings = Context.empty() as Context.Context<Binding<ActionId<H[number]>>>;
			const provided: ReadonlyArray<Handler<Action.Any, unknown, Services<H[number]>>> =
				handlers;
			for (const handler of provided) {
				const mapError = Effect.mapError(
					(cause: unknown) =>
						new BoundHandlerError({ actionId: handler.action.id, cause }),
				);
				const bound: BoundHandler = {
					[TypeId]: TypeId,
					action: handler.action,
					body: mapError(Effect.provideContext(handler.body, context)),
					precondition:
						handler.precondition === undefined
							? undefined
							: mapError(Effect.provideContext(handler.precondition, context)),
					skipReason: handler.skipReason,
				};
				bindings = Context.add(bindings, bindingKey(handler.action.id), bound);
			}

			return bindings;
		}),
	);
