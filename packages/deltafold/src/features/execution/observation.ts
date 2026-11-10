import {
	Cause,
	Clock,
	Deferred,
	Duration,
	Effect,
	Exit,
	Option,
	Predicate,
	Semaphore,
} from "effect";

import type * as Plan from "../../foundation/plan.ts";
import type { Occurrence, Step } from "../../foundation/plan.ts";
import type { Outcome, Report } from "./executor.ts";
import type { Phase } from "./handler.ts";
import type * as Observer from "./observer.ts";

const stepIdOf = (occurrence: Occurrence) =>
	occurrence.direction === "forward"
		? occurrence.migration.id
		: `${occurrence.migration.id}/revert`;

/** Declared occurrences behind an occurrence, through nested replacements, in order. */
const leavesOf = (occurrence: Occurrence): ReadonlyArray<Occurrence> =>
	occurrence.origin._tag === "Declared"
		? [occurrence]
		: occurrence.origin.replaces.flatMap(leavesOf);

const sourcesOf = (occurrence: Occurrence): ReadonlyArray<string> => [
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

const stepInfoOf = (step: Step, index: number, plan: Plan.Any): Observer.StepInfo => {
	const occurrences = occurrencesOfNode(step.node);
	const base = {
		id: step.id,
		index,
		migration: step.migration.id,
		direction: step.direction,
		from: step.from.id,
		to: step.to.id,
		occurrences: occurrences.map((occurrence) => occurrence.id),
		absorbs: [...new Set(occurrences.flatMap(sourcesOf))].filter((id) => id !== step.id),
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

const actionInfoOf = (occurrence: Occurrence, step: string): Observer.ActionInfo => ({
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
	sources: sourcesOf(occurrence),
});

const errorTagOf = (error: unknown) =>
	Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : undefined;

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
		case "PreconditionFailed":
			return { _tag: "PreconditionFailed", errorTag: errorTagOf(outcome.error) };
	}
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
	PreconditionFailed: 0,
	unsettled: 0,
});

/** Emits events for one run. Without observers, every method is a no-op. */
export type Emitter = {
	readonly runStarted: Effect.Effect<void, never, any>;
	readonly stepStarted: (step: Step) => Effect.Effect<void, never, any>;
	readonly stepSettled: (step: Step) => Effect.Effect<void, never, any>;
	readonly phaseStarted: (
		occurrence: Occurrence,
		phase: Phase,
	) => Effect.Effect<void, never, any>;
	/** Emits the occurrence's current outcome from the shared outcome map. */
	readonly settled: (occurrence: Occurrence) => Effect.Effect<void, never, any>;
	readonly runFinished: (status: Report["status"]) => Effect.Effect<void, never, any>;
	/** Emits a report-less `RunFinished` after fiber interruption, if the run had started. */
	readonly interrupted: Effect.Effect<void, never, any>;
	readonly failures: ReadonlyArray<Observer.ObservationFailure>;
};

const noop: Emitter = {
	runStarted: Effect.void,
	stepStarted: () => Effect.void,
	stepSettled: () => Effect.void,
	phaseStarted: () => Effect.void,
	settled: () => Effect.void,
	runFinished: () => Effect.void,
	interrupted: Effect.void,
	failures: [],
};

export type EmitterOptions = {
	readonly plan: Plan.Any;
	readonly mode: Report["mode"];
	readonly runId: string | undefined;
	readonly observers: ReadonlyArray<Observer.Any>;
	readonly outcomes: ReadonlyMap<string, Outcome>;
	/** Completes when cancellation or a timeout stops the run. */
	readonly stopped: Deferred.Deferred<void>;
	readonly grace: Duration.Input;
};

/**
 * Delivery is awaited and serialized: one event at a time, to each observer in order.
 * Counters change under the same lock, so each event's progress is consistent with the
 * order observers see. Observer failures are recorded and never reach the run.
 */
export const makeEmitter = (options: EmitterOptions): Effect.Effect<Emitter> =>
	Effect.gen(function* () {
		const { plan, observers, outcomes, stopped, grace } = options;
		if (observers.length === 0) return noop;

		const lock = yield* Semaphore.make(1);
		const failures: Array<Observer.ObservationFailure> = [];
		const run: Observer.Run = {
			id: options.runId,
			mode: options.mode,
			from: plan.from.id,
			to: plan.to.id,
			route: plan.route.id,
		};
		const steps = plan.steps.map((step, index) => stepInfoOf(step, index, plan));
		const infoOf = new Map(plan.steps.map((step, index) => [step, steps[index]]));
		const ownerOf = new Map<string, string>();
		for (const info of steps) for (const id of info.occurrences) ownerOf.set(id, info.id);

		const state = {
			seq: 0,
			running: new Set<string>(),
			actionsFinished: 0,
			stepsFinished: 0,
			started: false,
			finished: false,
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

		/** Bounds a delivery once the run has been stopped, or always when `bounded` is set. */
		const deliver = (observer: Observer.Any, event: Observer.Event, bounded: boolean) => {
			const notify = Effect.interruptible(Effect.exit(observer.notify(event)));
			const limit = bounded
				? Effect.sleep(grace)
				: Effect.andThen(Deferred.await(stopped), Effect.sleep(grace));

			return Effect.raceFirst(
				Effect.map(notify, (exit) => Option.some(exit)),
				Effect.as(limit, Option.none<Exit.Exit<void, unknown>>()),
			);
		};

		const emit = (
			update: () => void,
			build: (base: {
				readonly run: Observer.Run;
				readonly seq: number;
				readonly timestamp: number;
				readonly progress: Observer.Progress;
			}) => Observer.Event,
			bounded = false,
		): Effect.Effect<void, never, any> =>
			lock.withPermits(1)(
				Effect.gen(function* () {
					update();
					const timestamp = yield* Clock.currentTimeMillis;
					const event = build({ run, seq: state.seq, timestamp, progress: progress() });
					state.seq += 1;
					for (const [index, observer] of observers.entries()) {
						const result = yield* deliver(observer, event, bounded);
						if (Option.isNone(result)) {
							failures.push({
								observer: index,
								event: event._tag,
								seq: event.seq,
								reason: "abandoned",
								cause: Cause.interrupt(),
							});
						} else if (Exit.isFailure(result.value)) {
							failures.push({
								observer: index,
								event: event._tag,
								seq: event.seq,
								reason: "failed",
								cause: result.value.cause,
							});
						}
					}
				}),
			);

		const stepEvent = (step: Step) => infoOf.get(step) ?? stepInfoOf(step, -1, plan);
		const actionOf = (occurrence: Occurrence) =>
			actionInfoOf(occurrence, ownerOf.get(occurrence.id) ?? stepIdOf(occurrence));

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
				emit(
					() => {
						state.running.delete(occurrence.id);
						state.actionsFinished += 1;
					},
					(base) => ({
						...base,
						_tag: "ActionSettled",
						action: actionOf(occurrence),
						outcome: summaryOf(outcomes.get(occurrence.id) ?? { _tag: "Unattempted" }),
					}),
				),
			runFinished: (status) => finish(status, true, false),
			interrupted: Effect.suspend(() =>
				state.started && !state.finished ? finish("interrupted", false, true) : Effect.void,
			),
			failures,
		};
	});
