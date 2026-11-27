import { Effect, Logger } from "effect";

import { make as makeOutput, Output } from "../output.ts";
import type { Definition } from "./definition.ts";

/**
 * effect/cli passes a handler its command path, which ends with the subcommand. Without
 * one, the migrator's own name.
 */
export const programOf = (definition: Definition, commandPath: ReadonlyArray<string> | undefined) =>
	commandPath === undefined || commandPath.length < 2
		? [definition.name]
		: commandPath.slice(0, -1);

/** Also keeps Effect logs off stdout. */
export const withOutput =
	(program: ReadonlyArray<string>) =>
	<A, E, R>(effect: Effect.Effect<A, E, R | Output>) =>
		effect.pipe(
			Effect.provideServiceEffect(Output, makeOutput(program)),
			Effect.provideService(Logger.LogToStderr, true),
		);

export const examples =
	(entries: ReadonlyArray<{ readonly args: string; readonly description: string }>) =>
	({ commandPath }: { readonly commandPath: ReadonlyArray<string> }) =>
		entries.map((entry) => ({
			command: `${commandPath.join(" ")} ${entry.args}`,
			description: entry.description,
		}));
