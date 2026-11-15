import { Effect, Result, Semaphore, Terminal } from "effect";

import type { Occurrence } from "../../foundation/plan.ts";
import * as Interaction from "../execution/interaction.ts";
import type * as Observer from "../execution/observer.ts";
import type { Output } from "./output.ts";

/** What stopped the run: the first action that was declined, failed, or timed out. */
type Stop = {
	readonly occurrence: string;
	readonly reason: "was declined" | "failed" | "timed out";
};

/** The latest known stop of a run, shared by its prompts and its progress observer. */
type Stops = {
	readonly current: () => Stop | undefined;
	readonly record: (stop: Stop) => void;
};

/**
 * The text a person sees for manual work: the occurrence's migration instruction, or the
 * action description when it has none, as the guide shows it. Paragraphs become lines.
 */
export const instructionText = (occurrence: Occurrence): ReadonlyArray<string> => {
	const { instruction } = occurrence;
	if (instruction === undefined) return [occurrence.action.description];
	const text = instruction.content
		.map((item) => (item._tag === "Text" ? item.text : item.action.description))
		.join("");
	const paragraphs = text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
		.filter((paragraph) => paragraph !== "");

	return paragraphs.length === 0 ? [occurrence.action.description] : paragraphs;
};

const answers = {
	y: "confirmed",
	yes: "confirmed",
	n: "declined",
	no: "declined",
} as const satisfies Record<string, Interaction.Answer>;

const isAnswerKey = (value: string): value is keyof typeof answers => Object.hasOwn(answers, value);

/**
 * Shows one manual occurrence and reads answers until one is valid. A prompt shown after
 * the run started stopping says so: its step had already started, and settles normally.
 */
const ask = (output: Output["Service"], cancel: () => void, stops: Stops, occurrence: Occurrence) =>
	Effect.gen(function* () {
		const terminal = yield* Terminal.Terminal;
		const { err } = output;
		const stop = stops.current();
		yield* output.failure([
			"",
			err.yellow(`Manual step ${occurrence.id}`),
			...instructionText(occurrence).map((line) => `  ${line}`),
			...(stop === undefined
				? []
				: [
						err.yellow(`The run is stopping: ${stop.occurrence} ${stop.reason}.`),
						"This step had already started; confirm only if you completed it.",
					]),
		]);
		for (;;) {
			yield* output.prompt("Did you complete it? (y/n) ");
			const line = yield* Effect.result(terminal.readLine);
			if (Result.isFailure(line)) {
				yield* output.failure("");
				cancel();

				return yield* Effect.never;
			}
			const answer = line.success.trim().toLowerCase();
			if (isAnswerKey(answer)) {
				// Recorded now, so that a prompt waiting for this one already knows.
				if (answers[answer] === "declined") {
					stops.record({ occurrence: occurrence.id, reason: "was declined" });
				}

				return answers[answer];
			}
			yield* output.failure("Answer y or n.");
		}
	});

/**
 * Asks a person on the terminal to confirm manual work, one prompt at a time, and holds
 * progress lines while a prompt is open. `cancel` aborts the run: at the end of input it
 * runs before the prompt stops, so the executor records the confirmation as interrupted,
 * never as declined. Ctrl+C reaches the run as an interruption of the CLI. `observe`
 * receives the run's events to learn when it starts stopping.
 */
export const make = (output: Output["Service"], cancel: () => void) =>
	Effect.gen(function* () {
		const semaphore = yield* Semaphore.make(1);
		let prompting = false;
		let held: Array<ReadonlyArray<string>> = [];
		let stopped: Stop | undefined;
		const stops: Stops = {
			current: () => stopped,
			record: (stop) => {
				stopped ??= stop;
			},
		};

		/** Records the first action whose outcome stops the run. */
		const observe = (event: Observer.Event) =>
			Effect.sync(() => {
				if (event._tag !== "ActionSettled") return;
				const { occurrence } = event.action;
				const { outcome } = event;
				if (outcome._tag === "Declined")
					stops.record({ occurrence, reason: "was declined" });
				else if (outcome._tag === "Failed" || outcome._tag === "PreparationFailed") {
					stops.record({ occurrence, reason: "failed" });
				} else if (outcome._tag === "Interrupted" && outcome.reason === "timeout") {
					stops.record({ occurrence, reason: "timed out" });
				}
			});

		const flush = Effect.suspend(() => {
			const pending = held;
			held = [];

			return Effect.forEach(pending, (lines) => output.diagnostic(lines), { discard: true });
		});

		/** Writes progress lines now, or after the open prompt. */
		const progress = (lines: ReadonlyArray<string>) =>
			prompting
				? Effect.sync(() => {
						held.push(lines);
					})
				: output.diagnostic(lines);

		const interaction = Interaction.effect(({ occurrence }) =>
			Semaphore.withPermits(
				semaphore,
				1,
			)(
				Effect.acquireUseRelease(
					Effect.sync(() => {
						prompting = true;
					}),
					() => ask(output, cancel, stops, occurrence),
					() =>
						Effect.andThen(
							Effect.sync(() => {
								prompting = false;
							}),
							flush,
						),
				),
			),
		);

		return { interaction, progress, observe };
	});
