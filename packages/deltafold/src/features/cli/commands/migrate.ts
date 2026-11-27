import type { Context } from "effect";
import { Duration, Effect, Fiber, Option } from "effect";
import { Command, Flag } from "effect/cli";

import * as Plan from "../../../foundation/plan.ts";
import {
	ExecutionFailed,
	ExecutionInterrupted,
	HandlerCoverageError,
	InteractionUnavailable,
	runPromise,
} from "../../execution/executor.ts";
import type { Report } from "../../execution/executor.ts";
import type * as Handler from "../../execution/handler.ts";
import * as Observer from "../../execution/observer.ts";
import * as Encode from "../encode.ts";
import { capped, CliFailure, fail, schemaVersion } from "../failure.ts";
import { Output, stringify } from "../output.ts";
import * as Prompt from "../prompt.ts";
import * as Render from "../render.ts";
import type { Definition } from "./definition.ts";
import { durationFlag, fromFlag, policyFlag, routeFlag, toFlag } from "./flags.ts";
import { examples, programOf, withOutput } from "./program.ts";
import { resolve, selectionArgs } from "./selection.ts";

/** `--action-timeout` and `--settle-timeout` as given, for suggested commands. */
const limitArgs = (input: {
	readonly actionTimeout: Option.Option<Duration.Duration>;
	readonly settleTimeout: Option.Option<Duration.Duration>;
}) => [
	...Option.match(input.actionTimeout, {
		onNone: () => [],
		onSome: (value) => ["--action-timeout", `${Duration.toMillis(value)}ms`],
	}),
	...Option.match(input.settleTimeout, {
		onNone: () => [],
		onSome: (value) => ["--settle-timeout", `${Duration.toMillis(value)}ms`],
	}),
];

type Settled =
	| { readonly _tag: "Report"; readonly report: Report }
	| { readonly _tag: "Rejected"; readonly error: unknown };

const coverageLines = (error: HandlerCoverageError) =>
	error.issues.map((issue) => {
		const origin =
			issue.rule === undefined
				? ""
				: `, produced by rule ${issue.rule} from ${issue.replaces.map((entry) => entry.occurrenceId).join(", ")}`;

		return `${issue._tag} handler for ${issue.actionId} (${issue.description}) at ${issue.occurrenceId}${origin}`;
	});

export const migrateCommand = (
	definition: Definition,
	loadHandlers: () => Promise<ReadonlyArray<Handler.Any>>,
) =>
	Command.make(
		"migrate",
		{
			from: fromFlag,
			to: toFlag,
			route: routeFlag,
			policy: policyFlag,
			dryRun: Flag.Boolean("dry-run").pipe(
				Flag.withDefault(false),
				Flag.withDescription("Run prepare phases without applying any action"),
			),
			actionTimeout: durationFlag(
				"action-timeout",
				"Interrupt a prepare, apply, or verification phase that runs longer, and start no new actions",
			),
			settleTimeout: durationFlag(
				"settle-timeout",
				"How long to wait for an interrupted action to stop (default: 5s)",
			),
		},
		(input, commandPath?: ReadonlyArray<string>) =>
			withOutput(programOf(definition, commandPath))(
				Effect.gen(function* () {
					const output = yield* Output;
					const args = [
						...selectionArgs("migrate", input),
						...(input.dryRun ? ["--dry-run"] : []),
						...limitArgs(input),
					];
					const plan = yield* resolve(definition, input, args);

					yield* output.diagnostic("Loading handlers", "Debug");
					const handlers = yield* Effect.tryPromise({
						try: loadHandlers,
						catch: Encode.error,
					}).pipe(
						Effect.catch((error) =>
							fail({
								reason: "handlers_load_failed",
								message: "Couldn't load the migration handlers",
								status: "error",
								exitCode: 1,
								details: [error.message],
								data: { error },
							}),
						),
					);
					const loadObservers = definition.observers;
					const supplied =
						loadObservers === undefined
							? []
							: yield* Effect.tryPromise({
									try: loadObservers,
									catch: Encode.error,
								}).pipe(
									Effect.catch((error) =>
										fail({
											reason: "observers_load_failed",
											message: "Couldn't load the migration observers",
											status: "error",
											exitCode: 1,
											details: [error.message],
											data: { error },
										}),
									),
								);

					const actions = `${Render.plural(plan.occurrences.length, "action")} in ${Render.plural(plan.steps.length, "migration")}`;
					yield* output.diagnostic(
						input.dryRun
							? `Preparing ${actions} from ${plan.from.id} to ${plan.to.id} (dry run)`
							: `Running ${actions} from ${plan.from.id} to ${plan.to.id}`,
					);

					// Runs at the Promise boundary so that cancellation still produces the partial
					// report: interrupting this fiber aborts the signal and waits for the report.
					// The handlers' services are whatever the caller provided to the CLI effect; their
					// static type is carried by `Cli<R>`, not by the erased handler array here.
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion
					const services = (yield* Effect.context()) as Context.Context<any>;
					const controller = new AbortController();
					// Manual work is confirmed only by a person at a terminal. Without one, the
					// executor refuses to start a run that has manual handlers. A dry run never asks.
					const terminal = yield* Prompt.make(output, () => controller.abort());
					const interaction =
						output.interactive && !input.dryRun
							? { interaction: terminal.interaction }
							: {};
					// The supplied observers run first, in order; the CLI's progress
					// observer runs last, waits while a prompt is open, and is left out with --json.
					const progress = Observer.effect((event) => {
						const lines = Render.progress(event, output.err);

						return Effect.andThen(
							terminal.observe(event),
							lines.length === 0 ? Effect.void : terminal.progress(lines),
						);
					});
					const observers = output.json ? supplied : [...supplied, progress];
					const execute = (): Promise<Settled> =>
						runPromise(Plan.withRuntimeCoverage(plan), {
							handlers,
							observers,
							...interaction,
							dryRun: input.dryRun,
							signal: controller.signal,
							services,
							...(Option.isSome(input.actionTimeout)
								? { timeout: input.actionTimeout.value }
								: {}),
							...(Option.isSome(input.settleTimeout)
								? { settleTimeout: input.settleTimeout.value }
								: {}),
						}).then(
							(report): Settled => ({ _tag: "Report", report }),
							(error: unknown): Settled => ({ _tag: "Rejected", error }),
						);

					const printReport = (report: Report) =>
						Effect.gen(function* () {
							yield* output.result(
								output.json
									? stringify({
											schemaVersion,
											package: definition.package.name,
											report: Encode.report(report, plan),
										})
									: Render.report(report, output.out),
							);
							const warnings = Render.observation(report, output.err);
							if (warnings.length > 0) yield* output.diagnostic(warnings, "Warn");
						});

					const settled = yield* Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							const fiber = yield* Effect.forkChild(Effect.promise(execute));

							return yield* restore(Fiber.join(fiber)).pipe(
								Effect.onInterrupt(() =>
									Effect.gen(function* () {
										controller.abort();
										yield* output.diagnostic(
											"Canceling. Waiting for running actions to stop.",
											"Warn",
										);
										const final = yield* Fiber.join(fiber);
										// A run that failed before the interruption still carries its report.
										if (final._tag === "Report")
											yield* printReport(final.report);
										else if (
											final.error instanceof ExecutionInterrupted ||
											final.error instanceof ExecutionFailed
										)
											yield* printReport(final.error.report);
										yield* output.diagnostic("Canceled.", "Warn");
									}),
								),
							);
						}),
					);

					if (settled._tag === "Report") {
						yield* printReport(settled.report);

						return yield* settled.report.status === "would-fail"
							? new CliFailure({
									reason: "would_fail",
									message: "A prepare phase failed in the dry run",
									exitCode: 1,
								})
							: Effect.void;
					}

					const { error } = settled;
					if (error instanceof InteractionUnavailable) {
						return yield* fail({
							reason: "interaction_required",
							message: `${Render.plural(error.occurrences.length, "manual action")} need a person to confirm them in a terminal`,
							status: "action_required",
							exitCode: 2,
							details: [
								...capped(error.occurrences.map((occurrence) => occurrence.id)),
								"Run migrate in a terminal, without --json and outside CI. Nothing ran.",
							],
							data: {
								occurrences: error.occurrences.map((occurrence) => ({
									id: occurrence.id,
									action: occurrence.action.id,
									kind: occurrence.action.kind,
									description: occurrence.action.description,
									migration: occurrence.migration.id,
								})),
							},
							next: [
								{
									purpose: "dry-run",
									label: "Preview without applying actions",
									args: [
										...selectionArgs("migrate", input),
										"--route",
										plan.route.id,
										"--dry-run",
										...limitArgs(input),
									],
								},
							],
						});
					}
					if (error instanceof HandlerCoverageError) {
						return yield* fail({
							reason: "handler_coverage",
							message: `${Render.plural(error.issues.length, "planned action")} without exactly one matching handler`,
							status: "error",
							exitCode: 1,
							details: coverageLines(error),
							data: {
								issues: error.issues.map((issue) => ({
									tag: issue._tag,
									occurrence: issue.occurrenceId,
									action: issue.actionId,
									description: issue.description,
									migration: issue.migrationId,
									rule: issue.rule ?? null,
									replaces: issue.replaces.map((entry) => ({
										occurrence: entry.occurrenceId,
										description: entry.description,
									})),
								})),
							},
						});
					}
					if (error instanceof ExecutionFailed) {
						yield* printReport(error.report);

						return yield* new CliFailure({
							reason:
								error.failures.length === 0 && error.declined.length > 0
									? "manual_work_declined"
									: "execution_failed",
							message: error.message,
							exitCode: 1,
						});
					}
					if (error instanceof ExecutionInterrupted) {
						yield* printReport(error.report);
						if (error.reason === "cancelled") {
							// The CLI cancelled the run itself, at the end of input to a prompt. It
							// ends like any other cancellation.
							yield* output.diagnostic("Canceled.", "Warn");

							return yield* Effect.interrupt;
						}

						return yield* new CliFailure({
							reason: "timeout",
							message: error.message,
							exitCode: 1,
						});
					}

					return yield* fail({
						reason: "internal_error",
						message: "The migration could not run",
						status: "error",
						exitCode: 1,
						details: [Encode.error(error).message],
						data: { error: Encode.error(error) },
					});
				}),
			),
	).pipe(
		Command.withDescription(
			"Run the planned actions with the package's handlers. Pass --dry-run to run only prepare phases.",
		),
		Command.withExamples(
			examples([
				{
					args: "--from 1.0.0 --to 2.0.0 --dry-run",
					description: "Preview without applying actions",
				},
				{ args: "--from 1.0.0 --to 2.0.0", description: "Run the migration" },
				{
					args: "--from 1.0.0 --to 2.0.0 --json > report.json",
					description: "Keep the report as JSON",
				},
			]),
		),
	);
