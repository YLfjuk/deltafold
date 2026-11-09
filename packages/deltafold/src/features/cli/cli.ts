import { Effect, Predicate, Stdio } from "effect";
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from "effect/cli";

import type * as Action from "../../foundation/action.ts";
import type { Release } from "../../foundation/version.ts";
import { make as makeChangelog, type Changelog } from "../documents/changelog.ts";
import type * as Handler from "../execution/handler.ts";
import type { Package } from "../package.ts";
import { commands } from "./commands.ts";
import { CliFailure, fail, schemaVersion, type Reason } from "./failure.ts";
import { Json, make as makeOutput, NoColor, Output } from "./output.ts";

export { CliFailure, schemaVersion, type Reason };

/**
 * Handlers for the `migrate` command: an array, or a function that loads one. A function
 * is called only when `migrate` runs, so help and the inspection commands never import
 * handler modules.
 *
 * @since @next
 */
export type Handlers<H> =
	| ReadonlyArray<H>
	| (() => ReadonlyArray<H> | PromiseLike<ReadonlyArray<H>>);

/** @since @next */
export type Options<A extends Action.Any, H extends Handler.Handler<A, any, any>, M> = {
	/** The command name shown in help and suggested commands, usually the bin name. */
	readonly name: string;
	/** Printed by `--version`. */
	readonly version: string;
	/** The root command's help summary. */
	readonly description?: string;
	/** Enables the `migrate` command. Coverage is checked at run time, before any action. */
	readonly handlers?: Handlers<H>;
	/** Configures change sections and plugins for `guide` and `changelog`. */
	readonly changelog?: Changelog<M>;
	/** Release metadata for every released version. Enables the `changelog` command. */
	readonly releases?: ReadonlyArray<Release<M>> | (() => ReadonlyArray<Release<M>>);
};

/**
 * A package's migrator CLI. `command` is an `effect/cli` command that can run on its own
 * with `Cli.run`, or be mounted as a subcommand of another CLI. `R` is the Effect services
 * of the handlers, which the caller provides.
 *
 * `effect/cli` is marked unstable in Effect 4, so the type of `command` may change with
 * Effect releases.
 *
 * @since @next
 */
export type Cli<R = never> = {
	readonly _tag: "Cli";
	readonly name: string;
	readonly version: string;
	readonly package: Package;
	readonly command: Command.Command<string, any, any, CliFailure, R | Command.Environment>;
	/** Type-level record of the handlers' Effect services. */
	readonly "~services"?: R;
};

/**
 * Builds the migrator CLI for a package: `validate`, `plan`, `upgrades`, `downgrades`, and
 * `guide`, plus `migrate` when handlers are supplied and `changelog` when release metadata
 * is supplied.
 *
 * Building the CLI and showing help never load handlers, run preconditions, or touch
 * consumer files. Importing the module that declares the package still runs that module's
 * top-level code.
 *
 * @example
 * ```ts
 * import { NodeRuntime, NodeServices } from "@effect/platform-node";
 * import { Effect } from "effect";
 * import { Cli } from "deltafold/cli";
 *
 * const cli = Cli.make(widgets, {
 * 	name: "widgets-migrate",
 * 	version: "2.0.0",
 * 	handlers: () => import("./handlers.js").then((module) => module.handlers),
 * });
 *
 * Cli.run(cli).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
 * ```
 *
 * @since @next
 */
export const make = <
	A extends Action.Any,
	H extends Handler.Handler<A, any, any> = never,
	M = never,
>(
	pkg: Package<A>,
	options: Options<A, H, M>,
): Cli<Handler.Services<H>> => {
	const { handlers, releases } = options;
	const command: Command.Command<string, any, any, CliFailure, Command.Environment> = commands({
		name: options.name,
		description:
			options.description ?? `Plan and run migrations between versions of ${pkg.name}`,
		package: pkg,
		changelog: options.changelog ?? makeChangelog(),
		releases:
			releases === undefined
				? undefined
				: typeof releases === "function"
					? releases
					: () => releases,
		handlers:
			handlers === undefined
				? undefined
				: async () => (typeof handlers === "function" ? await handlers() : handlers),
	});

	return { _tag: "Cli", name: options.name, version: options.version, package: pkg, command };
};

const reasonByTag: Record<CliError.CliError["_tag"], Reason> = {
	UnrecognizedOption: "unknown_option",
	DuplicateOption: "invalid_arguments",
	MissingOption: "missing_option",
	MissingArgument: "missing_option",
	UnexpectedArgument: "invalid_arguments",
	InvalidValue: "invalid_value",
	UnknownSubcommand: "unknown_command",
	ValidationError: "invalid_arguments",
	UserError: "invalid_arguments",
	ShowHelp: "invalid_arguments",
};

// Help and version go to stdout. Usage errors are reported by `run` on stderr instead of
// printing the full help, so stdout only ever holds a requested result.
const presenter = CliOutput.layerPresenter({
	present: (event) =>
		event._tag === "InvalidInvocation"
			? Effect.void
			: CliOutput.defaultPresenter.present(event),
});

// No interactive wizard: the CLI never prompts.
const config = CliConfig.layer({
	builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions, GlobalFlag.LogLevel],
});

/** Whether `--json` appears before `--`, for reporting usage errors that stop parsing. */
const wantsJson = (argv: ReadonlyArray<string>) => {
	const end = argv.indexOf("--");

	return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
};

const usageFailure = (error: CliError.ShowHelp, argv: ReadonlyArray<string>) => {
	const [first] = error.errors;
	const message = first?.message.split("\n")[0] ?? "Invalid arguments";
	const [program = "", ...path] = error.commandPath;

	return fail(program, {
		reason: first === undefined ? "invalid_arguments" : reasonByTag[first._tag],
		message,
		status: "error",
		exitCode: 2,
		details: error.errors.flatMap((entry, index) => {
			const lines = entry.message.split("\n").filter((line) => line.trim() !== "");

			return index === 0 ? lines.slice(1) : lines;
		}),
		data: {
			errors: error.errors.map((entry) => ({ tag: entry._tag, message: entry.message })),
		},
		next: [{ purpose: "help", label: "See help", args: [...path, "--help"], text: true }],
	}).pipe(
		Effect.provideServiceEffect(Output, makeOutput),
		Effect.provideService(Json, wantsJson(argv)),
		Effect.provideService(NoColor, argv.includes("--no-color")),
	);
};

/**
 * Runs the CLI with `argv`, or with the arguments from the `Stdio` service. Provide the
 * platform services (for example `NodeServices.layer`) and the handlers' services, and run
 * it with the platform's main runner, which turns failures into exit codes: 0 on success,
 * 1 for operational failures, 2 for usage errors and choices the caller must make, and 130
 * when interrupted.
 *
 * @since @next
 */
export const run = <R>(
	cli: Cli<R>,
	argv?: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure, R | Command.Environment> =>
	Effect.gen(function* () {
		const args = argv ?? (yield* (yield* Stdio.Stdio).args);

		return yield* Command.runWith(cli.command, { version: cli.version })(args).pipe(
			Effect.catchIf(CliError.isCliError, (error) => {
				if (error._tag === "ShowHelp") {
					return error.errors.length === 0 ? Effect.void : usageFailure(error, args);
				}

				return usageFailure(
					new CliError.ShowHelp({ commandPath: [cli.name], errors: [error] }),
					args,
				);
			}),
		);
	}).pipe(Effect.provide([presenter, config]));

/** @since @next */
export const isCli = (value: unknown): value is Cli<unknown> => Predicate.isTagged(value, "Cli");
