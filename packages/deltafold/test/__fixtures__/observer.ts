import { expect } from "@effect/vitest";

import { type Executor, Observer } from "deltafold";

/** Cancels the run when the given phase starts, before the phase can run. */
export const abortingAt = (controller: AbortController, phase: string) =>
	Observer.promise(async (event) => {
		if (event._tag === "ActionPhaseStarted" && event.phase === phase) controller.abort();
	});

export const recorder = () => {
	const events: Array<Observer.Event> = [];

	return { events, observer: Observer.sync((event) => void events.push(event)) };
};

export const tags = (events: ReadonlyArray<Observer.Event>) =>
	events.map((event) => {
		switch (event._tag) {
			case "StepStarted":
			case "StepSettled":
				return `${event._tag}:${event.step.id}`;
			case "ActionPhaseStarted":
				return `${event._tag}:${event.action.action}:${event.phase}`;
			case "ActionSettled":
				return `${event._tag}:${event.action.action}:${event.outcome._tag}`;
		}

		return event._tag;
	});

/** Checks the guarantees every event stream must keep, against the final report. */
export const checkInvariants = (
	events: ReadonlyArray<Observer.Event>,
	report?: Executor.Report,
) => {
	expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
	expect(events[0]?._tag).toBe("RunStarted");
	expect(events.filter((event) => event._tag === "RunStarted")).toHaveLength(1);
	expect(events.filter((event) => event._tag === "RunFinished")).toHaveLength(1);
	expect(events.at(-1)?._tag).toBe("RunFinished");

	for (const [index, event] of events.entries()) {
		const previous = events[index - 1];
		if (previous === undefined) continue;
		expect(event.progress.actions.finished).toBeGreaterThanOrEqual(
			previous.progress.actions.finished,
		);
		expect(event.progress.steps.finished).toBeGreaterThanOrEqual(
			previous.progress.steps.finished,
		);
	}

	const started = new Set<string>();
	const settled: Array<string> = [];
	for (const event of events) {
		if (event._tag === "ActionPhaseStarted") started.add(event.action.occurrence);
		if (event._tag === "ActionSettled") settled.push(event.action.occurrence);
	}
	expect(new Set(settled).size).toBe(settled.length);
	const finished = events.at(-1);
	// After fiber interruption, occurrences that were running never settle.
	if (finished?._tag === "RunFinished" && !finished.report) return;
	for (const occurrence of started) expect(settled).toContain(occurrence);

	if (report === undefined || finished?._tag !== "RunFinished") return;
	expect(finished.status).toBe(report.status);
	expect(finished.report).toBe(true);
	const counts: Record<string, number> = {};
	for (const entry of report.occurrences)
		counts[entry.outcome._tag] = (counts[entry.outcome._tag] ?? 0) + 1;
	for (const [tag, count] of Object.entries(finished.counts)) {
		if (tag !== "unsettled") expect([tag, count]).toEqual([tag, counts[tag] ?? 0]);
	}
};
