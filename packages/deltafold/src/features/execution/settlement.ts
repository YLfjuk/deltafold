import { Context, Duration, Effect, Option } from "effect";

import * as PackageConfig from "../../configs/package.ts";

/**
 * How the executor learns whether an interrupted Promise callback settled. Effect stops
 * waiting for a Promise when it is interrupted, but the Promise itself can keep running.
 */
export type Settlement = {
	/** How long to keep waiting for an interrupted Promise before reporting it pending. */
	readonly grace: Duration.Input;
	/** Receives an interrupted Promise that did not settle within the grace period. */
	readonly unsettled: (promise: Promise<void>) => void;
};

export const SettlementReference = Context.Reference<Settlement>(
	`${PackageConfig.name}/Settlement`,
	{
		defaultValue: () => ({ grace: Duration.zero, unsettled: () => {} }),
	},
);

/**
 * Runs a Promise-producing effect. If it is interrupted after the Promise started,
 * waits up to the settlement grace period and hands a still-pending Promise to the
 * settlement, which can hold resources until it settles.
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

					const settles = started.then(
						() => undefined,
						() => undefined,
					);
					const settlement = yield* SettlementReference;
					const settled = yield* Effect.promise(() => settles).pipe(
						Effect.timeoutOption(settlement.grace),
					);
					if (Option.isNone(settled)) settlement.unsettled(settles);
				}),
			),
		);
	});
