import { Effect, Result, Semaphore, Terminal } from "effect";

import type { Occurrence } from "../../foundation/plan.ts";
import * as Interaction from "../execution/interaction.ts";
import type { Output } from "./output.ts";

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

/** Shows one manual occurrence and reads answers until one is valid. */
const ask = (output: Output["Service"], cancel: () => void, occurrence: Occurrence) =>
	Effect.gen(function* () {
		const terminal = yield* Terminal.Terminal;
		const { err } = output;
		yield* output.failure([
			"",
			err.yellow(`Manual step ${occurrence.id}`),
			...instructionText(occurrence).map((line) => `  ${line}`),
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
			if (isAnswerKey(answer)) return answers[answer];
			yield* output.failure("Answer y or n.");
		}
	});

/**
 * Asks a person on the terminal to confirm manual work, one prompt at a time, and holds
 * progress lines while a prompt is open. `cancel` aborts the run: at the end of input it
 * runs before the prompt stops, so the executor records the confirmation as interrupted,
 * never as declined. Ctrl+C reaches the run as an interruption of the CLI.
 */
export const make = (output: Output["Service"], cancel: () => void) =>
	Effect.gen(function* () {
		const semaphore = yield* Semaphore.make(1);
		let prompting = false;
		let held: Array<ReadonlyArray<string>> = [];

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
					() => ask(output, cancel, occurrence),
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

		return { interaction, progress };
	});
