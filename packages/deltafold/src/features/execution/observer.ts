import { type Cause, Effect, Predicate } from "effect";

import type * as Plan from "../../foundation/plan.ts";
import type { Outcome, Report } from "./executor.ts";
import type { Performer, Phase } from "./handler.ts";

const TypeId = "~deltafold/Observer";

/**
 * The run that emitted an event.
 *
 * @since @next
 */
export type Run = {
	/** The `runId` passed to the executor, if any. Shared observers use it to tell runs apart. */
	readonly id: string | undefined;
	readonly mode: Report["mode"];
	readonly from: string;
	readonly to: string;
	readonly route: string;
};

/**
 * Counters at the moment an event was emitted. Counters never decrease during a run.
 *
 * @since @next
 */
export type Progress = {
	/** Steps that run: steps with actions, and manual steps. Omitted steps are not counted. */
	readonly steps: { readonly total: number; readonly finished: number };
	readonly actions: {
		readonly total: number;
		/** Occurrences whose precondition or body has started and that have not settled. */
		readonly running: number;
		readonly finished: number;
	};
};

/**
 * One step of the route, as observers see it.
 *
 * - `execute`: the step has actions after optimization.
 * - `manual`: the step has instructions but no actions. The executor does not wait at it.
 * - `omitted`: a noop, or a step whose actions rules removed or moved into another step.
 *
 * @since @next
 */
export type StepInfo = {
	/** The plan step's `id`. */
	readonly id: string;
	/** Position in `plan.steps`, including omitted steps. */
	readonly index: number;
	readonly migration: string;
	readonly direction: Plan.Direction;
	readonly from: string;
	readonly to: string;
	/** Occurrence identifiers of the step, in plan order. */
	readonly occurrences: ReadonlyArray<string>;
	/**
	 * Other steps whose declared actions this step's replacements stand for. Running this
	 * step performs work that those steps declared.
	 */
	readonly absorbs: ReadonlyArray<string>;
} & (
	| { readonly kind: "execute" | "manual" }
	| { readonly kind: "omitted"; readonly reason: "noop" | "all-actions-removed" }
);

/**
 * One occurrence of the plan, as observers see it.
 *
 * @since @next
 */
export type ActionInfo = {
	readonly occurrence: string;
	readonly action: string;
	readonly kind: string;
	readonly description: string;
	readonly migration: string;
	readonly direction: Plan.Direction;
	/** The step that runs the occurrence. */
	readonly step: string;
	readonly origin:
		| { readonly _tag: "Declared" }
		| {
				readonly _tag: "Replacement";
				readonly rule: string;
				/** Identifiers of the replaced occurrences, in order. */
				readonly replaces: ReadonlyArray<string>;
		  };
	/** Steps that declared the actions behind this occurrence, in plan order. */
	readonly sources: ReadonlyArray<string>;
};

/**
 * An outcome as observers see it. Each variant lists its fields explicitly, so a field
 * added to the report's outcome never reaches observers unreviewed. A failure keeps only
 * the error's string `_tag`; the full error is in the execution's report.
 *
 * @since @next
 */
export type OutcomeSummary =
	| { readonly _tag: "Completed"; readonly performer: "automated" }
	| {
			readonly _tag: "Completed";
			readonly performer: "manual";
			readonly confirmation: "asserted" | "verified";
	  }
	| { readonly _tag: "Skipped"; readonly reason: string }
	| { readonly _tag: "Declined" }
	| {
			readonly _tag: "Failed";
			readonly phase: Phase;
			readonly errorTag: string | undefined;
	  }
	| {
			readonly _tag: "Interrupted";
			readonly phase: Phase;
			readonly reason: "cancelled" | "timeout";
			readonly settled: boolean;
	  }
	| { readonly _tag: "Unattempted" }
	| {
			readonly _tag: "WouldExecute";
			readonly evaluated: boolean;
			readonly performer: Performer;
	  }
	| { readonly _tag: "WouldSkip"; readonly reason: string }
	| {
			readonly _tag: "Undetermined";
			readonly reason: string;
			readonly performer: Performer;
	  }
	| { readonly _tag: "PreconditionFailed"; readonly errorTag: string | undefined };

/**
 * Occurrences by outcome tag. `unsettled` counts interrupted occurrences that may still be
 * running.
 *
 * @since @next
 */
export type Counts = { readonly [K in Outcome["_tag"]]: number } & {
	readonly unsettled: number;
};

type Base = {
	readonly run: Run;
	/** Position of the event in its run, starting at 0. */
	readonly seq: number;
	/** Milliseconds since the Unix epoch, from Effect's `Clock`. */
	readonly timestamp: number;
	readonly progress: Progress;
};

/**
 * Handler coverage passed and the run is starting. Lists every step of the route.
 *
 * @since @next
 */
export type RunStarted = Base & {
	readonly _tag: "RunStarted";
	readonly steps: ReadonlyArray<StepInfo>;
};

/** @since @next */
export type StepStarted = Base & { readonly _tag: "StepStarted"; readonly step: StepInfo };

/**
 * A phase of an occurrence started: its precondition, body, the confirmation of manual
 * work, or its verification. `confirmation` means the run is waiting for a person. An
 * occurrence emits this once per phase that starts.
 *
 * @since @next
 */
export type ActionPhaseStarted = Base & {
	readonly _tag: "ActionPhaseStarted";
	readonly action: ActionInfo;
	readonly phase: Phase;
};

/**
 * An occurrence has its final outcome. Emitted once for each occurrence whose outcome is
 * known, and as `Unattempted` for an occurrence whose precondition passed but whose body
 * did not start. Dry-run outcomes that need no precondition arrive without a start.
 *
 * @since @next
 */
export type ActionSettled = Base & {
	readonly _tag: "ActionSettled";
	readonly action: ActionInfo;
	readonly outcome: OutcomeSummary;
};

/**
 * A started step ended. `counts` covers the step's occurrences.
 *
 * @since @next
 */
export type StepSettled = Base & {
	readonly _tag: "StepSettled";
	readonly step: StepInfo;
	readonly counts: Counts;
};

/**
 * The run ended. `status` and `counts` match the execution's report. When the fiber of
 * `Executor.effect` is interrupted, there is no report: `report` is `false`, the status is
 * `"interrupted"`, and running occurrences count as unsettled interruptions.
 *
 * @since @next
 */
export type RunFinished = Base & {
	readonly _tag: "RunFinished";
	readonly status: Report["status"];
	readonly counts: Counts;
	readonly report: boolean;
};

/**
 * What an observer receives. Events carry identifiers and plain data, never payloads,
 * errors, or causes. Action descriptions are included, so they must not contain secrets.
 *
 * @since @next
 */
export type Event =
	| RunStarted
	| StepStarted
	| ActionPhaseStarted
	| ActionSettled
	| StepSettled
	| RunFinished;

/**
 * An observer that failed, or that was abandoned after cancellation or a timeout because
 * it did not finish within the settlement grace period. The cause can hold arbitrary
 * values, so do not serialize it as a whole.
 *
 * @since @next
 */
export type ObservationFailure = {
	/** Position of the observer in the `observers` array. */
	readonly observer: number;
	readonly event: Event["_tag"];
	readonly seq: number;
	readonly reason: "failed" | "abandoned";
	readonly cause: Cause.Cause<unknown>;
};

/**
 * Receives execution events. `R` is the Effect services it requires.
 *
 * @since @next
 */
export type Observer<out R = never> = {
	readonly [TypeId]: typeof TypeId;
	readonly notify: (event: Event) => Effect.Effect<void, unknown, R>;
};

/**
 * Any observer.
 *
 * @since @next
 */
export type Any = Observer<any>;

/**
 * The Effect services of an observer or a union of observers.
 *
 * @since @next
 */
export type Services<O> = O extends Observer<infer R> ? R : never;

/** @since @next */
export const isObserver = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId);

class AsyncSyncObserver extends Error {
	override readonly name = "AsyncSyncObserver";
	override readonly message =
		"An Observer.sync callback returned a Promise. Use Observer.promise for asynchronous callbacks.";
}

/**
 * Observes with a synchronous callback. A thrown value is recorded as an observation
 * failure.
 *
 * @example
 * ```ts
 * Observer.sync((event) => {
 * 	if (event._tag === "ActionSettled") console.error(event.action.occurrence, event.outcome._tag);
 * });
 * ```
 *
 * @since @next
 */
export const sync = (callback: (event: Event) => void): Observer => ({
	[TypeId]: TypeId,
	notify: (event) =>
		Effect.try({
			try: () => {
				const result: unknown = callback(event);
				if (Predicate.isPromiseLike(result)) {
					// Keep a rejection from going unhandled; the misuse is reported instead.
					Promise.resolve(result).catch(() => undefined);
					throw new AsyncSyncObserver();
				}
			},
			catch: (cause) => cause,
		}),
});

/**
 * Observes with a Promise callback. The executor waits for the Promise. The `signal`
 * aborts when the executor stops waiting: after cancellation or a timeout, once the
 * settlement grace period has passed, or when the execution is interrupted.
 *
 * @since @next
 */
export const promise = (
	callback: (event: Event, context: { readonly signal: AbortSignal }) => PromiseLike<unknown>,
): Observer => ({
	[TypeId]: TypeId,
	notify: (event) =>
		Effect.tryPromise({
			// Declaring `signal` makes Effect.tryPromise allocate an AbortController.
			try: (signal) => Promise.resolve(callback(event, { signal })),
			catch: (cause) => cause,
		}),
});

/**
 * Observes with an Effect. Its services become requirements of the execution. Its
 * failures are recorded as observation failures and never fail the execution.
 *
 * @example
 * ```ts
 * Observer.effect((event) => Effect.logDebug(event._tag));
 * ```
 *
 * @since @next
 */
export const effect = <R = never>(
	callback: (event: Event) => Effect.Effect<unknown, unknown, R>,
): Observer<R> => ({
	[TypeId]: TypeId,
	notify: (event) => Effect.asVoid(Effect.suspend(() => callback(event))),
});
