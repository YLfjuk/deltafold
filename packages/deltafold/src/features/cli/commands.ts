import { Context, Duration, Effect, FileSystem, Fiber, Logger, Option, Result } from "effect";
import { Command, Flag } from "effect/cli";

import * as Plan from "../../foundation/plan.ts";
import type { Release } from "../../foundation/version.ts";
import type { Changelog } from "../documents/changelog.ts";
import type { Document } from "../documents/document.ts";
import {
	ExecutionFailed,
	ExecutionInterrupted,
	HandlerCoverageError,
	runPromise,
	type Report,
} from "../execution/executor.ts";
import type * as Handler from "../execution/handler.ts";
import type { Package } from "../package.ts";
import * as History from "../planning/history.ts";
import type { RoutePolicy } from "../planning/resolve.ts";
import * as Encode from "./encode.ts";
import {
	CliFailure,
	fail,
	invocation,
	policies,
	resolveProblem,
	schemaVersion,
} from "./failure.ts";
import { Json, make as makeOutput, NoColor, Output, stringify } from "./output.ts";
import * as Render from "./render.ts";

/** What the command tree needs from `Cli.make`, with handler types erased. */
export type Definition = {
	readonly name: string;
	readonly description: string;
	readonly package: Package;
	readonly changelog: Changelog<any>;
	readonly releases: (() => ReadonlyArray<Release<any>>) | undefined;
	readonly handlers: (() => Promise<ReadonlyArray<Handler.Any>>) | undefined;
};

/** Gives a command handler its output service and keeps Effect logs off stdout. */
const withOutput = <A, E, R>(effect: Effect.Effect<A, E, R | Output>) =>
	effect.pipe(
		Effect.provideServiceEffect(Output, makeOutput),
		Effect.provideService(Logger.LogToStderr, true),
	);

const fromFlag = Flag.String("from").pipe(
	Flag.withMetavar("VERSION"),
	Flag.withDescription("Version to start from"),
);
const toFlag = Flag.String("to").pipe(
	Flag.withMetavar("VERSION"),
	Flag.withDescription("Version to reach"),
);
const routeFlag = Flag.String("route").pipe(
	Flag.withMetavar("ROUTE"),
	Flag.withDescription("Select a candidate route by its identifier"),
	Flag.optional,
);
const policyFlag = Flag.Literals("policy", policies).pipe(
	Flag.withDescription("Choose between candidate routes"),
	Flag.optional,
);
const explainFlag = Flag.Boolean("explain").pipe(
	Flag.withDefault(false),
	Flag.withDescription("Explain instructions that rules removed or replaced"),
);
const formatFlag = Flag.Literals("format", ["markdown", "html"]).pipe(
	Flag.withDefault("markdown"),
	Flag.withDescription("Document format"),
);
const outputFlag = Flag.String("output").pipe(
	Flag.withMetavar("PATH"),
	Flag.withDescription("Write the document to a file instead of stdout"),
	Flag.optional,
);

const unitMillis = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Parses durations such as `500ms`, `30s`, `2m`, or `1h`. */
export const parseDuration = (text: string): Option.Option<Duration.Duration> => {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
	const amount = match?.[1];
	const unit = match?.[2];
	if (amount === undefined || (unit !== "ms" && unit !== "s" && unit !== "m" && unit !== "h")) {
		return Option.none();
	}

	return Option.some(Duration.millis(Number(amount) * unitMillis[unit]));
};

const durationFlag = (name: string, description: string) =>
	Flag.String(name).pipe(
		Flag.withMetavar("DURATION"),
		Flag.withDescription(description),
		Flag.filterMap(
			parseDuration,
			(text) => `Expected a duration such as 500ms, 30s, or 2m, got "${text}"`,
		),
		Flag.optional,
	);

type Selection = {
	readonly from: string;
	readonly to: string;
	readonly route: Option.Option<string>;
	readonly policy: Option.Option<RoutePolicy>;
};

/**
 * Resolves the plan for a command, or reports why it cannot. `args` is the command's own
 * argument list, reused in suggested commands.
 */
const resolve = (definition: Definition, selection: Selection, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		if (Option.isSome(selection.route) && Option.isSome(selection.policy)) {
			return yield* fail(definition.name, {
				reason: "invalid_arguments",
				message: "Pass either --route or --policy, not both",
				status: "error",
				exitCode: 2,
			});
		}
		const resolved = History.resolve(definition.package.history, {
			from: selection.from,
			to: selection.to,
			...(Option.isSome(selection.route) ? { route: selection.route.value } : {}),
			...(Option.isSome(selection.policy) ? { policy: selection.policy.value } : {}),
		});
		if (Result.isSuccess(resolved)) return resolved.success;

		return yield* fail(
			definition.name,
			resolveProblem(resolved.failure, (extra) => [...args, ...extra]),
		);
	});

/** The arguments of a selection, without `--route` and `--policy`. */
const selectionArgs = (command: string, selection: Selection) => [
	command,
	"--from",
	selection.from,
	"--to",
	selection.to,
];

const examples =
	(entries: ReadonlyArray<{ readonly args: string; readonly description: string }>) =>
	({ commandPath }: { readonly commandPath: ReadonlyArray<string> }) =>
		entries.map((entry) => ({
			command: `${commandPath.join(" ")} ${entry.args}`,
			description: entry.description,
		}));

const validateCommand = (definition: Definition) =>
	Command.make("validate", {}, () =>
		withOutput(
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

const planCommand = (definition: Definition) =>
	Command.make(
		"plan",
		{ from: fromFlag, to: toFlag, route: routeFlag, policy: policyFlag, explain: explainFlag },
		(input) =>
			withOutput(
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
						const next = invocation(definition.name, false, [
							...selectionArgs("migrate", input),
							"--route",
							plan.route.id,
							"--dry-run",
						]);
						yield* output.diagnostic([
							"",
							"Check preconditions without running actions:",
							`    ${output.err.bold(next.command)}`,
						]);
					}
				}),
			),
	).pipe(
		Command.withDescription(
			"Resolve the route and instructions between two versions. Runs no handlers or preconditions.",
		),
		Command.withExamples(
			examples([
				{ args: "--from 1.0.0 --to 2.0.0", description: "Show the planned instructions" },
				{ args: "--from 1.0.0 --to 2.0.0 --json", description: "Print the plan as JSON" },
			]),
		),
	);

const destinationsCommand = (definition: Definition, kind: "upgrade" | "downgrade") =>
	Command.make(`${kind}s`, { from: fromFlag }, (input) =>
		withOutput(
			Effect.gen(function* () {
				const output = yield* Output;
				const { history, name } = definition.package;
				const found =
					kind === "upgrade"
						? History.upgrades(history, { from: input.from })
						: History.downgrades(history, { from: input.from });
				if (Result.isFailure(found)) {
					return yield* fail(
						definition.name,
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

const renderDocument = (document: Document, format: "markdown" | "html") =>
	format === "html"
		? Effect.promise(() => import("../../renderers/html.ts")).pipe(
				Effect.map((module) => module.render(document)),
			)
		: Effect.promise(() => import("../../renderers/markdown.ts")).pipe(
				Effect.map((module) => module.render(document)),
			);

type DocumentKind = "guide" | "history" | "release";

const printDocument = (
	definition: Definition,
	kind: DocumentKind,
	content: string,
	format: "markdown" | "html",
) =>
	Effect.gen(function* () {
		const output = yield* Output;

		return yield* output.result(
			output.json
				? stringify({
						schemaVersion,
						package: definition.package.name,
						document: { kind, format, content },
					})
				: content.replace(/\n$/, ""),
		);
	});

const writeDocument = (
	definition: Definition,
	kind: DocumentKind,
	content: string,
	format: "markdown" | "html",
	path: string,
) =>
	Effect.gen(function* () {
		const output = yield* Output;
		const fs = yield* FileSystem.FileSystem;
		const written = yield* Effect.result(fs.writeFileString(path, content));
		if (Result.isFailure(written)) {
			return yield* fail(definition.name, {
				reason: "write_failed",
				message: `Couldn't write the ${kind} to ${path}`,
				status: "error",
				exitCode: 1,
				details: [written.failure.message],
				data: { path },
			});
		}

		return yield* output.json
			? output.result(
					stringify({
						schemaVersion,
						package: definition.package.name,
						document: { kind, format, path },
					}),
				)
			: output.diagnostic(`Wrote the ${kind} to ${path}`);
	});

/** Prints a rendered document, or writes it to `--output`. */
const emitDocument = (
	definition: Definition,
	kind: DocumentKind,
	content: string,
	format: "markdown" | "html",
	path: Option.Option<string>,
) =>
	Option.isNone(path)
		? printDocument(definition, kind, content, format)
		: writeDocument(definition, kind, content, format, path.value);

const guideCommand = (definition: Definition) =>
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
		(input) =>
			withOutput(
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

const changelogCommand = (definition: Definition, releases: () => ReadonlyArray<Release<any>>) =>
	Command.make(
		"changelog",
		{
			release: Flag.String("release").pipe(
				Flag.withMetavar("VERSION"),
				Flag.withDescription("Render only this release"),
				Flag.optional,
			),
			format: formatFlag,
			output: outputFlag,
		},
		(input) =>
			withOutput(
				Effect.gen(function* () {
					const all = releases();
					const pkg = definition.package;
					const kind = Option.isSome(input.release) ? "release" : "history";
					const document = yield* Effect.try({
						try: () => {
							if (Option.isNone(input.release))
								return definition.changelog.history(pkg, { releases: all });
							const id = input.release.value;
							const release = all.find((entry) => entry.version.id === id);

							return release === undefined
								? undefined
								: definition.changelog.release(pkg, release);
						},
						catch: (error) => error,
					}).pipe(
						Effect.catch((error) =>
							fail(definition.name, {
								reason: "invalid_release_metadata",
								message: Encode.error(error).message,
								status: "error",
								exitCode: 1,
							}),
						),
					);
					if (document === undefined) {
						const known = all.map((entry) => entry.version.id);

						return yield* fail(definition.name, {
							reason: "unknown_version",
							message: `No release metadata for version "${Option.getOrElse(input.release, () => "")}"`,
							status: "error",
							exitCode: 2,
							details: [`Releases: ${known.join(", ") || "none"}`],
							data: { version: Option.getOrNull(input.release), known },
						});
					}
					const content = yield* renderDocument(document, input.format);

					return yield* emitDocument(
						definition,
						kind,
						content,
						input.format,
						input.output,
					);
				}),
			),
	).pipe(
		Command.withDescription("Render the release history, or one release"),
		Command.withExamples(
			examples([
				{ args: "", description: "Print the history as Markdown" },
				{ args: "--release 2.0.0", description: "Print one release" },
			]),
		),
	);

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

const migrateCommand = (
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
				Flag.withDescription("Evaluate preconditions without running any action body"),
			),
			actionTimeout: durationFlag(
				"action-timeout",
				"Interrupt a precondition or body that runs longer, and start no new actions",
			),
			settleTimeout: durationFlag(
				"settle-timeout",
				"How long to wait for an interrupted action to stop (default: 5s)",
			),
		},
		(input) =>
			withOutput(
				Effect.gen(function* () {
					const output = yield* Output;
					const name = definition.name;
					const args = [
						...selectionArgs("migrate", input),
						...(input.dryRun ? ["--dry-run"] : []),
					];
					const plan = yield* resolve(definition, input, args);

					yield* output.diagnostic("Loading handlers", "Debug");
					const handlers = yield* Effect.tryPromise({
						try: loadHandlers,
						catch: (error) => error,
					}).pipe(
						Effect.catch((error) =>
							fail(name, {
								reason: "handlers_load_failed",
								message: "Couldn't load the migration handlers",
								status: "error",
								exitCode: 1,
								details: [Encode.error(error).message],
								data: { error: Encode.error(error) },
							}),
						),
					);

					const actions = `${Render.plural(plan.occurrences.length, "action")} in ${Render.plural(plan.steps.length, "migration")}`;
					yield* output.diagnostic(
						input.dryRun
							? `Checking preconditions of ${actions} from ${plan.from.id} to ${plan.to.id} (dry run)`
							: `Running ${actions} from ${plan.from.id} to ${plan.to.id}`,
					);

					// Runs at the Promise boundary so that cancellation still produces the partial
					// report: interrupting this fiber aborts the signal and waits for the report.
					// The handlers' services are whatever the caller provided to the CLI effect; their
					// static type is carried by `Cli<R>`, not by the erased handler array here.
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion
					const services = (yield* Effect.context()) as Context.Context<any>;
					const controller = new AbortController();
					const execute = (): Promise<Settled> =>
						runPromise(Plan.withRuntimeCoverage(plan), {
							handlers,
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
						output.result(
							output.json
								? stringify({
										schemaVersion,
										package: definition.package.name,
										report: Encode.report(report),
									})
								: Render.report(report, output.out),
						);

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
										if (final._tag === "Report")
											yield* printReport(final.report);
										else if (final.error instanceof ExecutionInterrupted)
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
									message: "A precondition failed in the dry run",
									exitCode: 1,
								})
							: Effect.void;
					}

					const { error } = settled;
					if (error instanceof HandlerCoverageError) {
						return yield* fail(name, {
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
							reason: "execution_failed",
							message: error.message,
							exitCode: 1,
						});
					}
					if (error instanceof ExecutionInterrupted) {
						yield* printReport(error.report);

						return yield* new CliFailure({
							reason: error.reason === "timeout" ? "timeout" : "execution_failed",
							message: error.message,
							exitCode: 1,
						});
					}

					return yield* fail(name, {
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
			"Run the planned actions with the package's handlers. Pass --dry-run to only evaluate preconditions.",
		),
		Command.withExamples(
			examples([
				{
					args: "--from 1.0.0 --to 2.0.0 --dry-run",
					description: "Check preconditions without running actions",
				},
				{ args: "--from 1.0.0 --to 2.0.0", description: "Run the migration" },
				{
					args: "--from 1.0.0 --to 2.0.0 --json > report.json",
					description: "Keep the report as JSON",
				},
			]),
		),
	);

/** Builds the command tree for a package. */
export const commands = (definition: Definition) => {
	const { handlers, releases } = definition;

	return Command.make(definition.name).pipe(
		Command.withDescription(definition.description),
		Command.withSubcommands([
			validateCommand(definition),
			planCommand(definition),
			destinationsCommand(definition, "upgrade"),
			destinationsCommand(definition, "downgrade"),
			...(handlers === undefined ? [] : [migrateCommand(definition, handlers)]),
			guideCommand(definition),
			...(releases === undefined ? [] : [changelogCommand(definition, releases)]),
		]),
		Command.withGlobalFlags([Json, NoColor]),
	);
};
