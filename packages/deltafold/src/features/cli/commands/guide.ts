import { Effect, Option } from "effect";
import { Command } from "effect/cli";

import type { Definition } from "./definition.ts";
import { emitDocument, renderDocument } from "./document.ts";
import {
	explainFlag,
	formatFlag,
	fromFlag,
	outputFlag,
	policyFlag,
	routeFlag,
	toFlag,
} from "./flags.ts";
import { examples, programOf, withOutput } from "./program.ts";
import { resolve, selectionArgs } from "./selection.ts";

export const guideCommand = (definition: Definition) =>
	Command.make(
		"guide",
		{
			from: fromFlag,
			to: toFlag,
			route: routeFlag,
			policy: policyFlag,
			explain: explainFlag,
			format: formatFlag,
			output: outputFlag,
		},
		(input, commandPath?: ReadonlyArray<string>) =>
			withOutput(programOf(definition, commandPath))(
				Effect.gen(function* () {
					const args = [
						...selectionArgs("guide", input),
						...(input.explain ? ["--explain"] : []),
						...(input.format === "markdown" ? [] : ["--format", input.format]),
						...(Option.isSome(input.output) ? ["--output", input.output.value] : []),
					];
					const plan = yield* resolve(definition, input, args);
					const document = definition.changelog.upgrade(plan, {
						package: definition.package,
						explain: input.explain,
					});
					const content = yield* renderDocument(document, input.format);
					yield* emitDocument(definition, "guide", content, input.format, input.output);
				}),
			),
	).pipe(
		Command.withDescription("Render the upgrade or downgrade guide between two versions"),
		Command.withExamples(
			examples([
				{ args: "--from 1.0.0 --to 2.0.0", description: "Print the guide as Markdown" },
				{
					args: "--from 1.0.0 --to 2.0.0 --format html --output guide.html",
					description: "Write the guide as HTML",
				},
			]),
		),
	);
