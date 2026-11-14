import type { Command } from "effect/cli";

import type * as Action from "../../foundation/action.ts";
import type { Release } from "../../foundation/version.ts";
import { make as makeChangelog, type Changelog } from "../documents/changelog.ts";
import type * as Handler from "../execution/handler.ts";
import type * as Observer from "../execution/observer.ts";
import type { Package } from "../package.ts";
import { commands } from "./commands.ts";
import { CliFailure, schemaVersion, type Reason } from "./failure.ts";

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
	/**
	 * The command name shown in help and suggested commands: the bin name, or the
	 * subcommand name when the command is mounted under another one. Defaults to the
	 * package name.
	 */
	readonly name?: string;
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
 * Builds a package's migrator command: `validate`, `plan`, `upgrades`, `downgrades`, and
 * `guide`, plus `migrate` when handlers are supplied and `changelog` when release metadata
 * is supplied.
 *
 * The result is an ordinary `effect/cli` command. Run it with `Cli.run`, or mount it
 * as a subcommand of another command, for example one command per package in a tool that
 * migrates several packages. Its Effect requirements include the handlers' services.
 * `effect/cli` is marked unstable in Effect 4, so the command's type may change with
 * Effect releases.
 *
 * `migrate` forwards the package's observers to the executor, in attachment order, and
 * then adds its own observer that prints progress on stderr (none with `--json`).
 *
 * Building the command and showing help never load handlers, run preconditions, or touch
 * consumer files. Importing the module that declares the package still runs that module's
 * top-level code.
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
	O extends Observer.Any = never,
	H extends Handler.Handler<A, any, any> = never,
	M = never,
>(
	pkg: Package<A, O>,
	options: Options<A, H, M> = {},
): Command.Command<
	string,
	any,
	any,
	CliFailure,
	Handler.Services<H> | Observer.Services<O> | Command.Environment
> => {
	const { handlers, releases } = options;
	const command: Command.Command<string, any, any, CliFailure, Command.Environment> = commands({
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
		handlers:
			handlers === undefined
				? undefined
				: async () => (typeof handlers === "function" ? await handlers() : handlers),
	});

	return command;
};
