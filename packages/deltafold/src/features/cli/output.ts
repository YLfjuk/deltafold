import { Config, Context, Effect, LogLevel, Option, References, Stdio, Stream } from "effect";
import { Flag, GlobalFlag } from "effect/cli";

/** `--json`: print one versioned JSON document instead of human output. */
export const Json = GlobalFlag.Setting("json")({
	flag: Flag.Boolean("json").pipe(
		Flag.withDefault(false),
		Flag.withDescription("Print one versioned JSON document on stdout"),
	),
});

/** `--no-color`: disable color in human output. */
export const NoColor = GlobalFlag.Setting("no-color")({
	flag: Flag.Boolean("no-color").pipe(
		Flag.withDefault(false),
		Flag.withDescription("Disable color"),
	),
});

/** Text styling for one stream. Styles are identity functions when color is off. */
export type Style = {
	/** Whether the stream is a terminal that is not `TERM=dumb`. */
	readonly rich: boolean;
	readonly bold: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly green: (text: string) => string;
	readonly yellow: (text: string) => string;
	readonly red: (text: string) => string;
	readonly arrow: string;
};

const sgr = (open: number, close: number) => (text: string) =>
	`\u001b[${open}m${text}\u001b[${close}m`;
const plain = (text: string) => text;

const makeStyle = (rich: boolean, color: boolean): Style => ({
	rich,
	bold: color ? sgr(1, 22) : plain,
	dim: color ? sgr(2, 22) : plain,
	green: color ? sgr(32, 39) : plain,
	yellow: color ? sgr(33, 39) : plain,
	red: color ? sgr(31, 39) : plain,
	arrow: rich ? "→" : "->",
});

/**
 * Where command results and diagnostics go. Results go to stdout; diagnostics, progress,
 * and errors go to stderr.
 */
export class Output extends Context.Service<
	Output,
	{
		readonly json: boolean;
		readonly out: Style;
		readonly err: Style;
		/** Writes lines of the command's result to stdout. */
		readonly result: (lines: string | ReadonlyArray<string>) => Effect.Effect<void>;
		/** Writes lines to stderr regardless of the log level, for failures. */
		readonly failure: (lines: string | ReadonlyArray<string>) => Effect.Effect<void>;
		/**
		 * Writes lines to stderr when the minimum log level admits `level`. With `--json`,
		 * diagnostics are dropped so that stderr holds at most one error document.
		 */
		readonly diagnostic: (
			lines: string | ReadonlyArray<string>,
			level?: LogLevel.LogLevel,
		) => Effect.Effect<void>;
	}
>()("deltafold/cli/Output") {}

const isPresent = (value: Option.Option<string>) => Option.isSome(value) && value.value.length > 0;

const environment = Config.all({
	noColor: Config.option(Config.String("NO_COLOR")),
	forceColor: Config.option(Config.String("FORCE_COLOR")),
	term: Config.option(Config.String("TERM")),
});

const toText = (lines: string | ReadonlyArray<string>) =>
	typeof lines === "string" ? `${lines}\n` : lines.map((line) => `${line}\n`).join("");

/**
 * Builds the output service from the standard streams, the environment, and the `--json`
 * and `--no-color` settings. Color precedence: `--no-color`, then a non-empty `NO_COLOR`,
 * then `FORCE_COLOR` (`0` and `false` mean off), then whether the stream is a terminal.
 * `TERM=dumb` turns off rich presentation and color unless color is forced.
 */
export const make = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio;
	const json = yield* Json;
	const noColorFlag = yield* NoColor;
	const env = yield* Effect.orDie(environment);
	const dumb = Option.getOrUndefined(env.term) === "dumb";
	const forced = Option.match(env.forceColor, {
		onNone: () => undefined,
		onSome: (value) =>
			value.length === 0 ? undefined : value !== "0" && value.toLowerCase() !== "false",
	});
	const styleFor = (terminal: boolean) => {
		const rich = terminal && !dumb;
		const color = !json && !noColorFlag && !isPresent(env.noColor) && (forced ?? rich);

		return makeStyle(rich, color);
	};
	const out = styleFor(yield* stdio.stdoutIsTerminal);
	const err = styleFor(yield* stdio.stderrIsTerminal);

	// A closed stream (for example `| head`) ends output quietly instead of failing.
	const write = (stream: "stdout" | "stderr", lines: string | ReadonlyArray<string>) =>
		Stream.make(toText(lines)).pipe(
			Stream.run(stream === "stdout" ? stdio.stdout() : stdio.stderr()),
			Effect.ignore,
		);

	return Output.of({
		json,
		out,
		err,
		result: (lines) => write("stdout", lines),
		failure: (lines) => write("stderr", lines),
		diagnostic: (lines, level = "Info") =>
			Effect.gen(function* () {
				const minimum = yield* References.MinimumLogLevel;
				if (!json && LogLevel.isGreaterThanOrEqualTo(level, minimum)) {
					yield* write("stderr", lines);
				}
			}),
	});
});

/** Serializes a JSON document as a single line. */
export const stringify = (document: unknown) => JSON.stringify(document);
