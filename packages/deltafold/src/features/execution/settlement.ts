import { Context, Duration, Effect, Option } from "effect";

/**
 * How the executor learns whether an interrupted Promise callback settled. Effect stops
 * waiting for a Promise when it is interrupted, but the Promise itself can keep running.
 */
export type Settlement = {
	/** How long to keep waiting for an interrupted Promise before reporting it pending. */
	readonly grace: Duration.Input;
	readonly record: (settled: boolean) => void;
};

export const SettlementReference = Context.Reference<Settlement>("deltafold/Settlement", {
	defaultValue: () => ({ grace: Duration.zero, record: () => {} }),
});

/**
 * Runs a Promise-producing effect. If it is interrupted after the Promise started,
 * waits up to the settlement grace period and records whether the Promise settled.
 */
export const trackPromise = <T, E, R>(
	start: (capture: (promise: Promise<T>) => Promise<T>) => Effect.Effect<T, E, R>,
): Effect.Effect<T, E, R> =>
	Effect.suspend(() => {
		let pending: Promise<T> | undefined;
		const capture = (promise: Promise<T>) => {
			pending = promise;

			return promise;
		};

		return start(capture).pipe(
			Effect.onInterrupt(() =>
				Effect.gen(function* () {
					const started = pending;
					if (started === undefined) return;

					const settlement = yield* SettlementReference;
					const settled = yield* Effect.promise(() =>
						started.then(
							() => undefined,
							() => undefined,
						),
					).pipe(Effect.timeoutOption(settlement.grace));
					settlement.record(Option.isSome(settled));
				}),
			),
		);
	});
