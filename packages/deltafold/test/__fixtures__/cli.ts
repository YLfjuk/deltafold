import {
	ConfigProvider,
	Console,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Path,
	Runtime,
	Sink,
	Stdio,
	Terminal,
} from "effect";
import type { Command } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";

import { History, Migration, Package, Shortcut, Version } from "deltafold";
import { addRetryLimit, AddKey, renameTimeout, retriesAdded, timeoutRenamed } from "./config.ts";

export const v1 = Version.make("1.0.0", { changes: [] });
export const v2 = Version.make("2.0.0", { previous: v1, changes: [timeoutRenamed] });
export const v3 = Version.make("3.0.0", { previous: v2, changes: [retriesAdded] });
export const v4 = Version.make("4.0.0", { previous: v3, changes: [] });

export const toV2 = Migration.make("1.0.0-to-2.0.0", {
	from: v1,
	to: v2,
	addresses: [timeoutRenamed],
})`${renameTimeout}`;
export const toV3 = Migration.make("2.0.0-to-3.0.0", {
	from: v2,
	to: v3,
	addresses: [retriesAdded],
})`${addRetryLimit}`;

export const addBoth = AddKey.make("add-both", { target: "config", key: "both" });
const direct = Migration.make("1.0.0-to-3.0.0", { from: v1, to: v3 })`${addBoth}`;

/** Two routes connect 1.0.0 and 3.0.0; no migration reaches 4.0.0. */
export const widgets = Package.make("@acme/widgets", {
	history: History.make({
		versions: [v1, v2, v3, v4],
		migrations: [toV2, toV3],
		shortcuts: [
			Shortcut.make("fast-upgrade", {
				from: v1,
				to: v3,
				replaces: [toV2, toV3],
				migrations: [direct],
			}),
		],
	}),
});

const collect = (target: Array<string>) => () =>
	Sink.forEach((chunk: string | Uint8Array) =>
		Effect.sync(() => {
			target.push(typeof chunk === "string" ? chunk : String.fromCharCode(...chunk));
		}),
	);

const ignore = () => {};

const format = (args: ReadonlyArray<unknown>) =>
	`${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}\n`;

const consoleTo = (stdout: Array<string>, stderr: Array<string>): Console.Console => ({
	assert: ignore,
	clear: ignore,
	count: ignore,
	countReset: ignore,
	debug: (...args) => stderr.push(format(args)),
	dir: ignore,
	dirxml: ignore,
	error: (...args) => stderr.push(format(args)),
	group: ignore,
	groupCollapsed: ignore,
	groupEnd: ignore,
	info: (...args) => stdout.push(format(args)),
	log: (...args) => stdout.push(format(args)),
	table: ignore,
	time: ignore,
	timeEnd: ignore,
	timeLog: ignore,
	trace: ignore,
	warn: (...args) => stderr.push(format(args)),
});

export type Terminal = {
	readonly env?: Readonly<Record<string, string>>;
	readonly stdoutIsTerminal?: boolean;
	readonly stderrIsTerminal?: boolean;
};

/** The exit code that the platform's main runner reports for an exit. */
export const exitCode = (exit: Exit.Exit<unknown, unknown>) => {
	let code = -1;
	Runtime.defaultTeardown(exit, (value) => {
		code = value;
	});

	return code;
};

/**
 * Captures what a CLI program writes to stdout and stderr, with an in-memory file system
 * and a controlled environment. Console output (help) is captured with the streams.
 */
export const terminal = (options: Terminal = {}) => {
	const stdout: Array<string> = [];
	const stderr: Array<string> = [];
	const files = new Map<string, string>();
	const layer = Layer.mergeAll(
		FileSystem.layerNoop({
			writeFileString: (path, data) =>
				Effect.sync(() => {
					files.set(path, data);
				}),
		}),
		Path.layer,
		Stdio.layerTest({
			stdout: collect(stdout),
			stderr: collect(stderr),
			stdoutIsTerminal: Effect.succeed(options.stdoutIsTerminal ?? false),
			stderrIsTerminal: Effect.succeed(options.stderrIsTerminal ?? false),
		}),
		Layer.succeed(
			Terminal.Terminal,
			Terminal.make({
				columns: Effect.succeed(100),
				rows: Effect.succeed(40),
				size: Effect.die("unused"),
				readInput: Effect.die("unused"),
				readLine: Effect.die("unused"),
				display: () => Effect.void,
			}),
		),
		Layer.succeed(
			ChildProcessSpawner.ChildProcessSpawner,
			ChildProcessSpawner.make(() => Effect.die("unused")),
		),
	);
	const provide = <A, E>(program: Effect.Effect<A, E, Command.Environment>) =>
		program.pipe(
			Effect.provide(layer),
			Effect.provideService(Console.Console, consoleTo(stdout, stderr)),
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromEnv({ env: { ...options.env } }),
			),
		);

	return {
		provide,
		files,
		stdout: () => stdout.join(""),
		stderr: () => stderr.join(""),
	};
};

/** Runs a program in a fresh terminal and returns its output and exit code. */
export const capture = <E>(
	program: Effect.Effect<void, E, Command.Environment>,
	options: Terminal = {},
) =>
	Effect.gen(function* () {
		const io = terminal(options);
		const exit = yield* Effect.exit(io.provide(program));

		return {
			exit,
			code: exitCode(exit),
			stdout: io.stdout(),
			stderr: io.stderr(),
			files: io.files,
		};
	});

/** Parses the single JSON document a stream holds. */
export const json = (text: string): any => {
	const lines = text.split("\n").filter((line) => line !== "");
	if (lines.length !== 1) throw new Error(`Expected one JSON line, got ${lines.length}: ${text}`);

	return JSON.parse(lines[0] ?? "");
};
