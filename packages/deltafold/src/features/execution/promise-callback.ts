import { Context, Effect, Schema } from "effect";

import type { ValueOf } from "../../types.ts";
import { trackPromise } from "./settlement.ts";

export type ServiceMap = { readonly [name: string | symbol]: Context.Key<any, any> };

// oxlint-disable-next-line typescript/no-generated-empty-object-type -- Callbacks without services declare an empty service map.
export type NoServices = Record<never, never>;

export type PromiseContext<S extends ServiceMap = NoServices> = {
	readonly signal: AbortSignal;
	readonly services: { readonly [K in keyof S]: S[K]["Service"] };
};

export type ServiceIds<S extends ServiceMap> = ValueOf<{
	[K in keyof S]: S[K] extends Context.Key<infer I, any> ? I : never;
}>;

export type ErrorGuard = Schema.Top | ((cause: unknown) => cause is any);

export type GuardedError<G> = G extends Schema.Top
	? G["Type"]
	: G extends ((cause: unknown) => cause is infer E)
		? E
		: never;

const declaredError =
	<G extends ReadonlyArray<ErrorGuard>>(guards: G) =>
	(cause: unknown): cause is GuardedError<G[number]> =>
		guards.some((guard) => (Schema.isSchema(guard) ? Schema.is(guard)(cause) : guard(cause)));

/**
 * Resolves declared services before each call; guarded rejections keep their type and
 * `unexpected` wraps the rest.
 */
export const adaptPromise = <S extends ServiceMap, G extends ReadonlyArray<ErrorGuard>>(options: {
	readonly services?: S | undefined;
	readonly errors?: G | undefined;
}) => {
	const isDeclared = declaredError(options.errors ?? []);
	const services: ServiceMap = options.services ?? {};
	// The callbacks require exactly the declared services. Reading them from the context
	// keeps that requirement typed; only the record of resolved services needs a cast,
	// because Object.fromEntries does not track keys.
	const resolve = Effect.map(
		Effect.context<ServiceIds<S>>(),
		(context) =>
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			Object.fromEntries(
				Reflect.ownKeys(services).flatMap((name) => {
					const service = services[name];

					return service === undefined ? [] : [[name, Context.get(context, service)]];
				}),
			) as { readonly [K in keyof S]: S[K]["Service"] },
	);

	return <T, U>(
		callback: (context: PromiseContext<S>) => PromiseLike<T> | T,
		unexpected: (cause: unknown) => U,
	): Effect.Effect<T, GuardedError<G[number]> | U, ServiceIds<S>> =>
		Effect.flatMap(resolve, (resolved) =>
			trackPromise((capture) =>
				Effect.tryPromise({
					// Declaring `signal` makes Effect.tryPromise allocate an AbortController.
					try: (signal) =>
						capture(Promise.resolve(callback({ signal, services: resolved }))),
					catch: (cause) => (isDeclared(cause) ? cause : unexpected(cause)),
				}),
			),
		);
};
