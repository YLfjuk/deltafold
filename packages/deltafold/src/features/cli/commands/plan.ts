import { Effect } from "effect";
import { Command } from "effect/cli";

import * as Plan from "../../../foundation/plan.ts";
import * as Encode from "../encode.ts";
import { invocation, schemaVersion } from "../failure.ts";
import { Output, stringify } from "../output.ts";
import * as Render from "../render.ts";
import type { Definition } from "./definition.ts";
import { explainFlag, fromFlag, policyFlag, routeFlag, toFlag } from "./flags.ts";
import { examples, programOf, withOutput } from "./program.ts";
import { resolve, selectionArgs } from "./selection.ts";

export const planCommand = (definition: Definition) =>
	Command.make(
		"plan",
		{ from: fromFlag, to: toFlag, route: routeFlag, policy: policyFlag, explain: explainFlag },
		(input, commandPath?: ReadonlyArray<string>) =>
			withOutput(programOf(definition, commandPath))(
				Effect.gen(function* () {
					const output = yield* Output;
					const args = [
						...selectionArgs("plan", input),
						...(input.explain ? ["--explain"] : []),
					];
					const plan = yield* resolve(definition, input, args);
					yield* output.result(
						output.json
							? stringify({
									schemaVersion,
									package: definition.package.name,
									plan: Encode.plan(plan),
								})
							: Render.plan(definition.package.name, plan, input.explain, output.out),
					);
					if (definition.handlers !== undefined && !Plan.isEmpty(plan)) {
						const next = invocation(output.program, false, [
							...selectionArgs("migrate", input),
							"--route",
							plan.route.id,
							"--dry-run",
						]);
						yield* output.diagnostic([
							"",
							"Preview with prepare phases, without applying actions:",
							`    ${output.err.bold(next.command)}`,
						]);
					}
				}),
			),
	).pipe(
		Command.withDescription(
			"Resolve the route and instructions between two versions. Runs no handlers or prepare phases.",
		),
		Command.withExamples(
			examples([
				{ args: "--from 1.0.0 --to 2.0.0", description: "Show the planned instructions" },
				{ args: "--from 1.0.0 --to 2.0.0 --json", description: "Print the plan as JSON" },
			]),
		),
	);
