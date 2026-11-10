import { Context, Effect, Schema } from "effect";

import { trackPromise } from "./settlement.ts";

/** Named Effect services that Promise callbacks declare. */
export type ServiceMap = { readonly [name: string]: Context.Key<any, any> };

// oxlint-disable-next-line typescript/no-generated-empty-object-type -- Callbacks without services declare an empty service map.
export type NoServices = Record<never, never>;

/** The declared services, resolved, and the `AbortSignal` aborted on interruption. */
export type PromiseContext<S extends ServiceMap = NoServices> = {
	readonly [K in keyof S]: S[K]["Service"];
} & { readonly signal: AbortSignal };

export type ServiceIds<S extends ServiceMap> = {
	[K in keyof S]: S[K] extends Context.Key<infer I, any> ? I : never;
}[keyof S];

/** Recognizes a declared rejection: a schema, or a type guard. */
export type ErrorGuard = Schema.Top | ((cause: unknown) => cause is any);

export type GuardedError<G> = G extends Schema.Top
	? G["Type"]
	: G extends ((cause: unknown) => cause is infer E)
		? E
		: never;

/** Rejects a service named `signal`, which is reserved for the AbortSignal. */
export type ReservedSignal<S> = "signal" extends keyof S
	? {
			readonly services: {
				readonly [K in keyof S]: K extends "signal"
					? "`signal` is reserved for the AbortSignal"
					: S[K];
			};
		}
	: unknown;

const declaredError =
	<G extends ReadonlyArray<ErrorGuard>>(guards: G) =>
	(cause: unknown): cause is GuardedError<G[number]> =>
		guards.some((guard) => (Schema.isSchema(guard) ? Schema.is(guard)(cause) : guard(cause)));

/**
 * Turns Promise callbacks into Effects. Declared services are resolved before each
 * call, rejections that a guard recognizes keep their type, and `unexpected` wraps the
 * rest.
 */
export const adaptPromise = <S extends ServiceMap, G extends ReadonlyArray<ErrorGuard>>(options: {
	readonly services?: S | undefined;
	readonly errors?: G | undefined;
}) => {
	const isDeclared = declaredError(options.errors ?? []);
	// Effect.all resolves each declared key to its service. TypeScript cannot relate its
	// conditional record type to the mapped context type while `S` is generic.
	const services: ServiceMap = options.services ?? {};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const resolve = Effect.all(services) as Effect.Effect<
		{ readonly [K in keyof S]: S[K]["Service"] },
		never,
		ServiceIds<S>
	>;

	return <T, U>(
		callback: (context: PromiseContext<S>) => PromiseLike<T> | T,
		unexpected: (cause: unknown) => U,
	): Effect.Effect<T, GuardedError<G[number]> | U, ServiceIds<S>> =>
		Effect.flatMap(resolve, (resolved) =>
			trackPromise((capture) =>
				Effect.tryPromise({
					// Declaring `signal` makes Effect.tryPromise allocate an AbortController.
					try: (signal) => capture(Promise.resolve(callback({ ...resolved, signal }))),
					catch: (cause) => (isDeclared(cause) ? cause : unexpected(cause)),
				}),
			),
		);
};
