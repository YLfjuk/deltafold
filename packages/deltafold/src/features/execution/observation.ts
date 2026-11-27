import type { Duration } from "effect";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Option, Predicate, Semaphore } from "effect";

import type * as Plan from "../../foundation/plan.ts";
import type { Occurrence, Step } from "../../foundation/plan.ts";
import type { Outcome, Report } from "./executor.ts";
import type { Phase } from "./handler.ts";
import type * as Observer from "./observer.ts";

/** Finds the identifier of the plan step that declared an occurrence's migration side. */
type StepIdOf = (occurrence: Occurrence) => string;

const stepIdsOf =
	(plan: Plan.Any): StepIdOf =>
	(occurrence) =>
		plan.steps.find(
			(step) =>
				step.migration === occurrence.migration && step.direction === occurrence.direction,
		)?.id ?? occurrence.migration.id;

/** Declared occurrences behind an occurrence, through nested replacements, in order. */
const leavesOf = (occurrence: Occurrence): ReadonlyArray<Occurrence> =>
	occurrence.origin._tag === "Declared"
		? [occurrence]
		: occurrence.origin.replaces.flatMap(leavesOf);

const sourcesOf = (occurrence: Occurrence, stepIdOf: StepIdOf): ReadonlyArray<string> => [
	...new Set(leavesOf(occurrence).map(stepIdOf)),
];

const occurrencesOfNode = (node: Plan.Node): ReadonlyArray<Occurrence> => {
	switch (node._tag) {
		case "Occurrence":
			return [node];
		case "Sequence":
			return node.children.flatMap(occurrencesOfNode);
	}

	return node.branches.flatMap(occurrencesOfNode);
};

const stepInfoOf = (
	step: Step,
	index: number,
	plan: Plan.Any,
	stepIdOf: StepIdOf,
): Observer.StepInfo => {
	const occurrences = occurrencesOfNode(step.node);
	const base = {
		id: step.id,
		index,
		migration: step.migration.id,
		direction: step.direction,
		from: step.from.id,
		to: step.to.id,
		occurrences: occurrences.map((occurrence) => occurrence.id),
		absorbs: [
			...new Set(occurrences.flatMap((occurrence) => sourcesOf(occurrence, stepIdOf))),
		].filter((id) => id !== step.id),
	};
	if (occurrences.length > 0) return { ...base, kind: "execute" };
	if (!step.omitted) return { ...base, kind: "prose" };
	const omitted = plan.explanations.find(
		(explanation) =>
			explanation._tag === "OmittedStep" &&
			explanation.migration.id === step.migration.id &&
			explanation.direction === step.direction,
	);

	return {
		...base,
		kind: "omitted",
		reason:
			omitted?._tag === "OmittedStep" && omitted.reason === "all-actions-removed"
				? "all-actions-removed"
				: "noop",
	};
};

const actionInfoOf = (
	occurrence: Occurrence,
	step: string,
	stepIdOf: StepIdOf,
): Observer.ActionInfo => ({
	occurrence: occurrence.id,
	action: occurrence.action.id,
	kind: occurrence.action.kind,
	description: occurrence.action.description,
	migration: occurrence.migration.id,
	direction: occurrence.direction,
	step,
	origin:
		occurrence.origin._tag === "Declared"
			? { _tag: "Declared" }
			: {
					_tag: "Replacement",
					rule: occurrence.origin.rule.id,
					replaces: occurrence.origin.replaces.map((replaced) => replaced.id),
				},
	sources: sourcesOf(occurrence, stepIdOf),
});

/**
 * Reads a handler error's tag once, so a getter cannot pass the check with one value and
 * return another. A tag that cannot be read, even by a throwing getter, is absent.
 */
const errorTagOf = (error: unknown): string | undefined => {
	try {
		if (!Predicate.hasProperty(error, "_tag")) return undefined;
		const tag: unknown = error._tag;

		return typeof tag === "string" ? tag : undefined;
	} catch {
		return undefined;
	}
};

/** Copies only the fields observers may see. */
const summaryOf = (outcome: Outcome): Observer.OutcomeSummary => {
	switch (outcome._tag) {
		case "Completed":
			return outcome.performer === "manual"
				? { _tag: "Completed", performer: "manual", confirmation: outcome.confirmation }
				: { _tag: "Completed", performer: "automated" };
		case "Skipped":
			return { _tag: "Skipped", reason: outcome.reason };
		case "Declined":
			return { _tag: "Declined" };
		case "Failed":
			return { _tag: "Failed", phase: outcome.phase, errorTag: errorTagOf(outcome.error) };
		case "Interrupted":
			return {
				_tag: "Interrupted",
				phase: outcome.phase,
				reason: outcome.reason,
				settled: outcome.settled,
			};
		case "Unattempted":
			return { _tag: "Unattempted" };
		case "WouldExecute":
			return {
				_tag: "WouldExecute",
				evaluated: outcome.evaluated,
				performer: outcome.performer,
			};
		case "WouldSkip":
			return { _tag: "WouldSkip", reason: outcome.reason };
		case "Undetermined":
			return { _tag: "Undetermined", reason: outcome.reason, performer: outcome.performer };
	}

	return { _tag: "PreparationFailed", errorTag: errorTagOf(outcome.error) };
};

const emptyCounts = (): { -readonly [K in keyof Observer.Counts]: number } => ({
	Completed: 0,
	Skipped: 0,
	Declined: 0,
	Failed: 0,
	Interrupted: 0,
	Unattempted: 0,
	WouldExecute: 0,
	WouldSkip: 0,
	Undetermined: 0,
	PreparationFailed: 0,
	unsettled: 0,
});

/** Without observers, every method is a no-op. */
export type Emitter<R> = {
	readonly runStarted: Effect.Effect<void, never, R>;
	readonly stepStarted: (step: Step) => Effect.Effect<void, never, R>;
	readonly stepSettled: (step: Step) => Effect.Effect<void, never, R>;
	readonly phaseStarted: (occurrence: Occurrence, phase: Phase) => Effect.Effect<void, never, R>;
	/**
	 * Emits the occurrence's current outcome from the shared outcome map, if it has one or
	 * has started. An occurrence that never started and has no outcome emits nothing.
	 */
	readonly settled: (occurrence: Occurrence) => Effect.Effect<void, never, R>;
	readonly runFinished: (status: Report["status"]) => Effect.Effect<void, never, R>;
	/** Emits a report-less `RunFinished` after fiber interruption, if the run had started. */
	readonly interrupted: Effect.Effect<void, never, R>;
	readonly failures: ReadonlyArray<Observer.ObservationFailure>;
};

const noop: Emitter<never> = {
	runStarted: Effect.void,
	stepStarted: () => Effect.void,
	stepSettled: () => Effect.void,
	phaseStarted: () => Effect.void,
	settled: () => Effect.void,
	runFinished: () => Effect.void,
	interrupted: Effect.void,
	failures: [],
};

export type EmitterOptions<R> = {
	readonly plan: Plan.Any;
	readonly mode: Report["mode"];
	readonly runId: string | undefined;
	readonly observers: ReadonlyArray<Observer.Observer<R>>;
	readonly outcomes: ReadonlyMap<string, Outcome>;
	/** Completes when cancellation or a timeout stops the run. */
	readonly stopped: Deferred.Deferred<void>;
	readonly grace: Duration.Input;
	/** Receives a fiber that ends when an abandoned callback stops, to keep services open. */
	readonly retain: (fiber: Fiber.Fiber<void>) => void;
};

/**
 * Delivery is awaited and serialized: one event at a time, to each observer in order.
 * Counters change under the same lock, so each event's progress is consistent with the
 * order observers see. Observer failures are recorded and never reach the run.
 */
export const makeEmitter = <R>(options: EmitterOptions<R>): Effect.Effect<Emitter<R>> =>
	Effect.gen(function* () {
		const { plan, observers, outcomes, stopped, grace, retain } = options;
		if (observers.length === 0) return noop;
		const stepIdOf = stepIdsOf(plan);

		const lock = yield* Semaphore.make(1);
		const failures: Array<Observer.ObservationFailure> = [];
		const run: Observer.Run = {
			id: options.runId,
			mode: options.mode,
			from: plan.from.id,
			to: plan.to.id,
			route: plan.route.id,
		};
		const steps = plan.steps.map((step, index) => stepInfoOf(step, index, plan, stepIdOf));
		const infoOf = new Map(plan.steps.map((step, index) => [step, steps[index]]));
		const ownerOf = new Map<string, string>();
		for (const info of steps) for (const id of info.occurrences) ownerOf.set(id, info.id);

		const state: {
			seq: number;
			running: Set<string>;
			actionsFinished: number;
			stepsFinished: number;
			started: boolean;
			finished: boolean;
			/** The event being delivered and the observer it is with, until every observer has it. */
			delivering: { readonly event: Observer.Event; readonly observer: number } | undefined;
		} = {
			seq: 0,
			running: new Set<string>(),
			actionsFinished: 0,
			stepsFinished: 0,
			started: false,
			finished: false,
			delivering: undefined,
		};
		const stepsTotal = steps.filter((info) => info.kind !== "omitted").length;
		const progress = (): Observer.Progress => ({
			steps: { total: stepsTotal, finished: state.stepsFinished },
			actions: {
				total: plan.occurrences.length,
				running: state.running.size,
				finished: state.actionsFinished,
			},
		});

		const countsOf = (occurrences: ReadonlyArray<Occurrence>, inFlight: boolean) => {
			const counts = emptyCounts();
			for (const occurrence of occurrences) {
				const outcome = outcomes.get(occurrence.id);
				if (outcome === undefined && inFlight && state.running.has(occurrence.id)) {
					counts.Interrupted += 1;
					counts.unsettled += 1;
					continue;
				}
				const tag = outcome?._tag ?? "Unattempted";
				counts[tag] += 1;
				if (outcome?._tag === "Interrupted" && !outcome.settled) counts.unsettled += 1;
			}

			return counts;
		};

		/**
		 * Interrupts an abandoned delivery without waiting for it to stop. The run's services
		 * stay open until it does.
		 */
		const abandon = (fiber: Fiber.Fiber<Exit.Exit<unknown, unknown>>) =>
			Effect.map(Effect.forkDetach(Fiber.interrupt(fiber)), retain);

		/**
		 * Bounds a delivery once the run has been stopped, or always when `bounded` is set.
		 * The callback runs in its own fiber, with the run's services, so a delivery that
		 * cannot be interrupted is still abandoned when the bound passes.
		 */
		const deliver = (
			observer: Observer.Observer<R>,
			event: Observer.Event,
			bounded: boolean,
		): Effect.Effect<Option.Option<Exit.Exit<unknown, unknown>>, never, R> =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const fiber = yield* Effect.forkDetach(
						Effect.interruptible(observer.notify(event)),
						{
							startImmediately: true,
						},
					);
					const limit = bounded
						? Effect.sleep(grace)
						: Effect.andThen(Deferred.await(stopped), Effect.sleep(grace));
					const result = yield* restore(
						Effect.raceFirst(
							Effect.map(Fiber.await(fiber), (exit) =>
								Option.some(Exit.isSuccess(exit) ? exit.value : exit),
							),
							Effect.as(limit, Option.none<Exit.Exit<unknown, unknown>>()),
						),
					).pipe(Effect.onInterrupt(() => abandon(fiber)));
					if (Option.isNone(result)) yield* abandon(fiber);

					return result;
				}),
			);

		const record = (
			observer: number,
			event: Observer.Event,
			result: Option.Option<Exit.Exit<unknown, unknown>>,
		) => {
			if (Option.isNone(result)) {
				failures.push({
					observer,
					event: event._tag,
					seq: event.seq,
					reason: "abandoned",
					cause: Cause.interrupt(),
				});
			} else if (Exit.isFailure(result.value)) {
				failures.push({
					observer,
					event: event._tag,
					seq: event.seq,
					reason: "failed",
					cause: result.value.cause,
				});
			}
		};

		const deliverFrom = (event: Observer.Event, first: number, bounded: boolean) =>
			Effect.gen(function* () {
				for (const [offset, observer] of observers.slice(first).entries()) {
					const index = first + offset;
					state.delivering = { event, observer: index };
					record(index, event, yield* deliver(observer, event, bounded));
				}
				state.delivering = undefined;
			});

		const emit = (
			update: () => void,
			build: (base: {
				readonly run: Observer.Run;
				readonly seq: number;
				readonly timestamp: number;
				readonly progress: Observer.Progress;
			}) => Observer.Event,
			bounded = false,
		): Effect.Effect<void, never, R> =>
			lock.withPermits(1)(
				Effect.gen(function* () {
					update();
					const timestamp = yield* Clock.currentTimeMillis;
					const event = build({ run, seq: state.seq, timestamp, progress: progress() });
					state.seq += 1;
					yield* deliverFrom(event, 0, bounded);
				}),
			);

		const stepEvent = (step: Step) => infoOf.get(step) ?? stepInfoOf(step, -1, plan, stepIdOf);
		const actionOf = (occurrence: Occurrence) =>
			actionInfoOf(occurrence, ownerOf.get(occurrence.id) ?? stepIdOf(occurrence), stepIdOf);

		const finish = (status: Report["status"], report: boolean, bounded: boolean) =>
			emit(
				() => {
					state.finished = true;
				},
				(base) => ({
					...base,
					_tag: "RunFinished",
					status,
					counts: countsOf(plan.occurrences, !report),
					report,
				}),
				bounded,
			);

		/**
		 * Ends the stream after fiber interruption. The delivery the interruption cut short is
		 * abandoned. If it was `RunFinished`, the observers that had not received it get a
		 * report-less one with the same `seq` instead, so each observer hears exactly one.
		 */
		const interrupted = Effect.suspend(() => {
			const cut = state.delivering;
			if (cut !== undefined) {
				record(cut.observer, cut.event, Option.none());
				state.delivering = undefined;
			}
			if (!state.started) return Effect.void;
			if (!state.finished) return finish("interrupted", false, true);
			if (cut?.event._tag !== "RunFinished") return Effect.void;
			const event: Observer.Event = {
				...cut.event,
				status: "interrupted",
				counts: countsOf(plan.occurrences, true),
				report: false,
			};

			return lock.withPermits(1)(deliverFrom(event, cut.observer + 1, true));
		});

		return {
			runStarted: emit(
				() => {
					state.started = true;
				},
				(base) => ({ ...base, _tag: "RunStarted", steps }),
			),
			stepStarted: (step) =>
				emit(
					() => {},
					(base) => ({ ...base, _tag: "StepStarted", step: stepEvent(step) }),
				),
			stepSettled: (step) =>
				emit(
					() => {
						state.stepsFinished += 1;
					},
					(base) => ({
						...base,
						_tag: "StepSettled",
						step: stepEvent(step),
						counts: countsOf(occurrencesOfNode(step.node), false),
					}),
				),
			phaseStarted: (occurrence, phase) =>
				emit(
					() => {
						state.running.add(occurrence.id);
					},
					(base) => ({
						...base,
						_tag: "ActionPhaseStarted",
						action: actionOf(occurrence),
						phase,
					}),
				),
			settled: (occurrence) =>
				Effect.suspend(() =>
					!outcomes.has(occurrence.id) && !state.running.has(occurrence.id)
						? Effect.void
						: emit(
								() => {
									state.running.delete(occurrence.id);
									state.actionsFinished += 1;
								},
								(base) => ({
									...base,
									_tag: "ActionSettled",
									action: actionOf(occurrence),
									outcome: summaryOf(
										outcomes.get(occurrence.id) ?? { _tag: "Unattempted" },
									),
								}),
							),
				),
			runFinished: (status) => finish(status, true, false),
			interrupted,
			failures,
		};
	});
