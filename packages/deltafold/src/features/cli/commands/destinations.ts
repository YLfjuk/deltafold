import { Effect, Result } from "effect";
import { Command } from "effect/cli";

import * as History from "../../planning/history.ts";
import * as Encode from "../encode.ts";
import { fail, resolveProblem, schemaVersion } from "../failure.ts";
import { Output, stringify } from "../output.ts";
import * as Render from "../render.ts";
import type { Definition } from "./definition.ts";
import { fromFlag } from "./flags.ts";
import { examples, programOf, withOutput } from "./program.ts";

export const destinationsCommand = (definition: Definition, kind: "upgrade" | "downgrade") =>
	Command.make(`${kind}s`, { from: fromFlag }, (input, commandPath?: ReadonlyArray<string>) =>
		withOutput(programOf(definition, commandPath))(
			Effect.gen(function* () {
				const output = yield* Output;
				const { history, name } = definition.package;
				const found =
					kind === "upgrade"
						? History.upgrades(history, { from: input.from })
						: History.downgrades(history, { from: input.from });
				if (Result.isFailure(found)) {
					return yield* fail(
						resolveProblem(found.failure, (extra) => [
							`${kind}s`,
							"--from",
							input.from,
							...extra,
						]),
					);
				}
				return yield* output.result(
					output.json
						? stringify({
								schemaVersion,
								package: name,
								from: input.from,
								direction: kind,
								destinations: found.success.map(Encode.destination),
							})
						: Render.destinations(input.from, kind, found.success, output.out),
				);
			}),
		),
	).pipe(
		Command.withDescription(
			`List versions reachable by ${kind} from a version, with their routes`,
		),
		Command.withExamples(
			examples([{ args: "--from 1.0.0", description: `List ${kind} destinations` }]),
		),
	);
