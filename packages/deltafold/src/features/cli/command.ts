import type { Command, GlobalFlag } from "effect/cli";

import type * as Action from "../../foundation/action.ts";
import type { Release } from "../../foundation/version.ts";
import { make as makeChangelog } from "../documents/changelog.ts";
import type { Changelog } from "../documents/changelog.ts";
import type * as Handler from "../execution/handler.ts";
import type * as Observer from "../execution/observer.ts";
import type { Package } from "../package.ts";
import { commands } from "./commands/tree.ts";
import { CliFailure, schemaVersion } from "./failure.ts";
import type { Reason } from "./failure.ts";

export { CliFailure, schemaVersion, type Reason };

/**
 * A loader function is called only when `migrate` runs, so help and the inspection
 * commands never import handler modules.
 *
 * @since @next
 */
export type Handlers<H> =
	| ReadonlyArray<H>
	| (() => ReadonlyArray<H> | PromiseLike<ReadonlyArray<H>>);

/**
 * A loader function is called only when `migrate` runs.
 *
 * @since @next
 */
export type Observers<O> =
	| ReadonlyArray<O>
	| (() => ReadonlyArray<O> | PromiseLike<ReadonlyArray<O>>);

/** Installed by `Cli.run` or another root command. */
type Settings = GlobalFlag.Setting.Identifier<"json"> | GlobalFlag.Setting.Identifier<"no-color">;

/** @since @next */
export type Options<
	A extends Action.Any,
	H extends Handler.Handler<A, any, any>,
	O extends Observer.Any,
	M,
> = {
	/** The bin name, or the subcommand name when mounted. Defaults to the package name. */
	readonly name?: string;
	/** Defaults to "Plan and run migrations between versions of <package>". */
	readonly description?: string;
	/** Enables the `migrate` command. Coverage is checked at run time, before any action. */
	readonly handlers?: Handlers<H>;
	/** Run before the CLI's progress observer. Their services join the command's requirements. */
	readonly observers?: Observers<O>;
	/** Used by `guide` and `changelog`. */
	readonly changelog?: Changelog<M>;
	/** One entry per released version. Enables the `changelog` command. */
	readonly releases?: ReadonlyArray<Release<M>> | (() => ReadonlyArray<Release<M>>);
};

/** Defers an array or loader until a command needs it. */
const loader = <T>(
	value: ReadonlyArray<T> | (() => ReadonlyArray<T> | PromiseLike<ReadonlyArray<T>>) | undefined,
) =>
	value === undefined
		? undefined
		: async () => (typeof value === "function" ? await value() : value);

/**
 * The command has `validate`, `plan`, `upgrades`, `downgrades`, and `guide`, plus
 * `migrate` when handlers are supplied and `changelog` when release metadata is supplied.
 * Building it and showing help never load handlers, run prepare phases, or touch consumer
 * files.
 *
 * Its requirements include the handlers' and observers' services and the shared `--json`
 * and `--no-color` settings. `Cli.run` installs those settings; another root installs
 * `Cli.Json` and `Cli.NoColor` with `Command.withGlobalFlags`. `migrate` runs
 * `observers` in order before its own progress observer, which `--json` leaves out.
 * `effect/cli` is unstable in Effect 4, so the command type can change with Effect
 * releases.
 *
 * @example
 * ```ts
 * import { NodeRuntime, NodeServices } from "@effect/platform-node";
 * import { Effect } from "effect";
 * import { Cli, Command } from "deltafold/cli";
 *
 * const widgetsCommand = Command.make(widgets, {
 * 	name: "widgets-migrate",
 * 	handlers: () => import("./handlers.js").then((module) => module.handlers),
 * });
 *
 * Cli.run(widgetsCommand, { version: "2.0.0" }).pipe(
 * 	Effect.provide(NodeServices.layer),
 * 	NodeRuntime.runMain,
 * );
 * ```
 *
 * @since @next
 */
export const make = <
	A extends Action.Any,
	H extends Handler.Handler<A, any, any> = never,
	O extends Observer.Any = never,
	M = never,
>(
	pkg: Package<A>,
	options: Options<A, H, O, M> = {},
): Command.Command<
	string,
	any,
	any,
	CliFailure,
	Handler.Services<H> | Observer.Services<O> | Settings | Command.Environment
> => {
	const { handlers, observers, releases } = options;
	const command: Command.Command<string, any, any, CliFailure, Settings | Command.Environment> =
		commands({
			name: options.name ?? pkg.name,
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
			handlers: loader(handlers),
			observers: loader(observers),
		});

	return command;
};
