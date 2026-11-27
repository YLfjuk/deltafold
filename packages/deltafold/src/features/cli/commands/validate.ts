import { Effect } from "effect";
import { Command } from "effect/cli";

import * as History from "../../planning/history.ts";
import * as Encode from "../encode.ts";
import { CliFailure, schemaVersion } from "../failure.ts";
import { Output, stringify } from "../output.ts";
import * as Render from "../render.ts";
import type { Definition } from "./definition.ts";
import { examples, programOf, withOutput } from "./program.ts";

export const validateCommand = (definition: Definition) =>
	Command.make("validate", {}, (_input, commandPath?: ReadonlyArray<string>) =>
		withOutput(programOf(definition, commandPath))(
			Effect.gen(function* () {
				const output = yield* Output;
				const { history, name } = definition.package;
				const found = History.validate(history);
				yield* output.result(
					output.json
						? stringify({
								schemaVersion,
								package: name,
								valid: found.length === 0,
								issues: found.map(Encode.issue),
							})
						: Render.issues(
								name,
								found,
								history.versions.length,
								history.migrations.length,
								output.out,
							),
				);
				return yield* found.length === 0
					? Effect.void
					: new CliFailure({
							reason: "invalid_history",
							message: `The history of ${name} has ${Render.plural(found.length, "issue")}`,
							exitCode: 1,
						});
			}),
		),
	).pipe(
		Command.withDescription("Check the history's declarations and list every issue"),
		Command.withExamples(examples([{ args: "", description: "Check the declarations" }])),
	);
