import { Effect, Option, Stdio } from "effect";
import type { Terminal } from "effect";
import { CliConfig, CliError, CliOutput, Command, GlobalFlag, Primitive } from "effect/cli";
import type { HelpDoc } from "effect/cli";

import type { CliFailure, Reason } from "./failure.ts";
import { fail } from "./failure.ts";
import { Json, make as makeOutput, NoColor, Output } from "./output.ts";

export { Json, NoColor };

/** The shared settings that `run` installs at the root. */
type Settings = GlobalFlag.Setting.Identifier<"json"> | GlobalFlag.Setting.Identifier<"no-color">;

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
// printing the full help, so stdout only ever holds a requested result. `onInvalid` keeps
// the selected command's help, which names its own flags.
const presenter = (onInvalid: (helpDoc: HelpDoc.HelpDoc) => void): CliOutput.Presenter => ({
	present: (event) =>
		event._tag === "InvalidInvocation"
			? Effect.sync(() => onInvalid(event.helpDoc))
			: CliOutput.defaultPresenter.present(event),
});

// No wizard: the only prompts are manual-handler confirmations.
const config = CliConfig.make({
	builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions, GlobalFlag.LogLevel],
});

const booleanLiteral = (value: string | undefined) =>
	value === undefined
		? Effect.succeed(undefined)
		: Primitive.Boolean.parse(value).pipe(Effect.option, Effect.map(Option.getOrUndefined));

/** Long flag names that the selected command claims for itself, without dashes. */
const localNames = (helpDoc: HelpDoc.HelpDoc | undefined) =>
	new Set(
		[...(helpDoc?.flags ?? []), ...(helpDoc?.inheritedFlags ?? [])].flatMap((flag) => [
			flag.name,
			...(flag.type === "boolean" ? [`no-${flag.name}`] : []),
			...flag.aliases.flatMap((alias) => (alias.startsWith("--") ? alias.slice(2) : [])),
		]),
	);

/**
 * Reads a boolean setting from the arguments before `--`, for usage errors that stop
 * parsing. A flag of the same name on the selected command takes the token, as in
 * effect/cli. Exactly one `--name`, `--name=<bool>`, or `--name <bool>` sets the value; a
 * missing, repeated, negated, or invalid setting reports the error as text.
 */
const readSetting = (argv: ReadonlyArray<string>, name: string, local: ReadonlySet<string>) =>
	Effect.gen(function* () {
		if (local.has(name)) return false;
		const end = argv.indexOf("--");
		const args = end === -1 ? argv : argv.slice(0, end);
		const negated = local.has(`no-${name}`) ? [] : [`--no-${name}`];
		const matches = args.flatMap((arg, index) =>
			[`--${name}`, ...negated].some((flag) => arg === flag || arg.startsWith(`${flag}=`))
				? index
				: [],
		);
		if (matches.length !== 1) return false;
		const [index = 0] = matches;
		const arg = args[index] ?? "";
		if (arg.startsWith("--no-")) return false;
		if (arg !== `--${name}`)
			return (yield* booleanLiteral(arg.slice(name.length + 3))) ?? false;

		return (yield* booleanLiteral(args[index + 1])) ?? true;
	});

const usageFailure = (
	error: CliError.ShowHelp,
	argv: ReadonlyArray<string>,
	helpDoc: HelpDoc.HelpDoc | undefined,
) => {
	const local = localNames(helpDoc);
	const [first] = error.errors;
	const message = first?.message.split("\n")[0] ?? "Invalid arguments";
	const [program = "", ...path] = error.commandPath;

	return fail({
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
		Effect.provideServiceEffect(Output, makeOutput([program])),
		Effect.provideServiceEffect(Json, readSetting(argv, "json", local)),
		Effect.provideServiceEffect(NoColor, readSetting(argv, "no-color", local)),
	);
};

/**
 * Reads `argv` from the `Stdio` service unless it is passed. Usage errors are reported on
 * stderr, or as one JSON document with `--json`, instead of the full help, and the
 * interactive wizard is off. The shared `Json` and `NoColor` settings are installed here,
 * at the root.
 *
 * Provide the platform services and the handlers' and observers' services, and run it with
 * the platform's main runner, which maps failures to exit codes: 0 on success, 1 for
 * operational failures, 2 for usage errors and choices the caller must make, and 130 when
 * interrupted.
 *
 * @since @next
 */
export const run = <Name extends string, Input, ContextInput, E, R>(
	command: Command.Command<Name, Input, ContextInput, E, R>,
	options: {
		readonly version: string;
		readonly argv?: ReadonlyArray<string>;
	},
): Effect.Effect<
	void,
	Exclude<Exclude<E, Terminal.QuitError>, CliError.CliError> | CliFailure,
	Exclude<R, Settings> | Command.Environment
> =>
	Effect.gen(function* () {
		const args = options.argv ?? (yield* (yield* Stdio.Stdio).args);
		// A root that already installs them keeps one copy: Effect dedupes global flags by
		// object identity.
		const root = Command.withGlobalFlags(command, [Json, NoColor]);
		let helpDoc: HelpDoc.HelpDoc | undefined;

		return yield* Command.runWith(root, { version: options.version })(args).pipe(
			Effect.provideService(
				CliOutput.Presenter,
				presenter((doc) => {
					helpDoc = doc;
				}),
			),
			Effect.catchIf(CliError.isCliError, (error) => {
				if (error._tag === "ShowHelp") {
					return error.errors.length === 0
						? Effect.void
						: usageFailure(error, args, helpDoc);
				}

				return usageFailure(
					new CliError.ShowHelp({ commandPath: [command.name], errors: [error] }),
					args,
					helpDoc,
				);
			}),
		);
	}).pipe(Effect.provideService(CliConfig.CliConfig, config));
