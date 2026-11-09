import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber } from "effect";
import * as EffectCli from "effect/cli";

import { Handler, Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import { Cli, Command } from "deltafold/cli";
import {
	addBoth,
	capture,
	exitCode,
	json,
	terminal,
	v1,
	v2,
	v3,
	v4,
	widgets,
} from "./__fixtures__/cli.ts";
import { addRetryLimit, renameTimeout, restoreTimeout } from "./__fixtures__/config.ts";

const ansi = "\u001b[";

const typeOnly = (_check: () => void) => {};

type Calls = Array<string>;

const handlersFor = (calls: Calls, options: { readonly failAddRetries?: boolean } = {}) => [
	Handler.promise(
		renameTimeout,
		async () => {
			calls.push("rename-timeout");
		},
		{
			when: async () => {
				calls.push("check rename-timeout");

				return true;
			},
		},
	),
	Handler.promise(addRetryLimit, async () => {
		calls.push("add-retry-limit");
		if (options.failAddRetries === true) {
			throw Object.assign(new Error("EACCES: permission denied, open 'config'"), {
				code: "EACCES",
			});
		}
	}),
	Handler.promise(addBoth, async () => {
		calls.push("add-both");
	}),
];

const migrator = (calls: Calls = [], options: { readonly failAddRetries?: boolean } = {}) => {
	let loads = 0;
	const cli = Command.make(widgets, {
		name: "widgets-migrate",
		handlers: async () => {
			loads += 1;

			return handlersFor(calls, options);
		},
		releases: [
			Version.withMetadata(v1, { date: "2026-01-01" }),
			Version.withMetadata(v2, { date: "2026-02-01" }),
			Version.withMetadata(v3, { date: "2026-03-01" }),
			Version.withMetadata(v4, { date: "2026-04-01" }),
		],
		changelog: Changelog.make<{ date: string }>(),
	});

	return { cli, loads: () => loads };
};

/** Runs a command as the top-level program with `argv`. */
const start = <E, R>(
	command: EffectCli.Command.Command<string, any, any, E, R>,
	argv: ReadonlyArray<string>,
) => Cli.run(command, { version: "4.0.0", argv });

const run = (
	argv: ReadonlyArray<string>,
	options: Parameters<typeof capture>[1] = {},
	calls: Calls = [],
) => capture(start(migrator(calls).cli, argv), options);

describe("help and loading", () => {
	it.effect("prints help on stdout without loading handlers", () =>
		Effect.gen(function* () {
			const { cli, loads } = migrator();
			const result = yield* capture(start(cli, ["--help"]));

			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			for (const command of [
				"validate",
				"plan",
				"upgrades",
				"downgrades",
				"migrate",
				"guide",
				"changelog",
			]) {
				expect(result.stdout).toContain(command);
			}
			expect(loads()).toBe(0);
		}),
	);

	it.effect("shows command examples under the command path", () =>
		Effect.gen(function* () {
			const result = yield* run(["migrate", "--help"]);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain(
				"widgets-migrate migrate --from 1.0.0 --to 2.0.0 --dry-run",
			);
		}),
	);

	it.effect("never loads handlers to inspect, plan, or render", () =>
		Effect.gen(function* () {
			const { cli, loads } = migrator();
			for (const argv of [
				["validate"],
				["plan", "--from", "1.0.0", "--to", "2.0.0"],
				["upgrades", "--from", "1.0.0"],
				["guide", "--from", "1.0.0", "--to", "2.0.0"],
				["changelog"],
			]) {
				expect((yield* capture(start(cli, argv))).code).toBe(0);
			}
			expect(loads()).toBe(0);
		}),
	);

	it.effect("names the command after the package by default", () =>
		Effect.gen(function* () {
			const command = Command.make(widgets);
			const help = yield* capture(start(command, ["--help"]));
			const ambiguous = yield* capture(
				start(command, ["plan", "--from", "1.0.0", "--to", "3.0.0", "--json"]),
			);

			expect(help.stdout).toContain("@acme/widgets <subcommand>");
			expect(json(ambiguous.stderr).next[0].argv[0]).toBe("@acme/widgets");
		}),
	);

	it.effect("leaves out migrate and changelog when handlers and releases are not supplied", () =>
		Effect.gen(function* () {
			const cli = Command.make(widgets, { name: "widgets-inspect" });
			const help = yield* capture(start(cli, ["--help"]));
			const migrate = yield* capture(
				start(cli, ["migrate", "--from", "1.0.0", "--to", "2.0.0"]),
			);

			expect(help.stdout).not.toContain("migrate ");
			expect(help.stdout).not.toContain("changelog");
			expect(migrate.code).toBe(2);
			expect(
				json(
					yield* capture(start(cli, ["migrate", "--json"])).pipe(
						Effect.map((result) => result.stderr),
					),
				).reason,
			).toBe("unknown_command");
		}),
	);
});

describe("usage errors", () => {
	it.effect("report an unknown option on stderr with exit 2 and an empty stdout", () =>
		Effect.gen(function* () {
			const result = yield* run(["plan", "--frm", "1.0.0", "--to", "2.0.0"]);

			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Unrecognized flag: --frm");
			expect(result.stderr).toContain("--from");
			expect(result.stderr).toContain("widgets-migrate plan --help");
		}),
	);

	it.effect("print one JSON error document with --json", () =>
		Effect.gen(function* () {
			const result = yield* run(["plan", "--from", "1.0.0", "--json"]);
			const document = json(result.stderr);

			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(document).toMatchObject({
				schemaVersion: 1,
				status: "error",
				reason: "missing_option",
			});
			expect(document.next[0].argv).toEqual(["widgets-migrate", "plan", "--help"]);
		}),
	);

	it.effect("reject --route together with --policy", () =>
		Effect.gen(function* () {
			const result = yield* run([
				"plan",
				"--from",
				"1.0.0",
				"--to",
				"3.0.0",
				"--route",
				"1.0.0>2.0.0>3.0.0",
				"--policy",
				"fewest-actions",
				"--json",
			]);

			expect(result.code).toBe(2);
			expect(json(result.stderr).reason).toBe("invalid_arguments");
		}),
	);
});

describe("validate", () => {
	it.effect("reports a valid history", () =>
		Effect.gen(function* () {
			const human = yield* run(["validate"]);
			const machine = yield* run(["validate", "--json"]);

			expect(human.code).toBe(0);
			expect(human.stdout).toContain(
				"The history of @acme/widgets is valid (4 versions, 2 migrations)",
			);
			expect(json(machine.stdout)).toEqual({
				schemaVersion: 1,
				package: "@acme/widgets",
				valid: true,
				issues: [],
			});
		}),
	);

	it.effect("prints issues as its result and exits 1", () =>
		Effect.gen(function* () {
			const broken = Command.make(
				{
					...widgets,
					history: { ...widgets.history, versions: [...widgets.history.versions, v1] },
				},
				{ name: "broken" },
			);
			const result = yield* capture(start(broken, ["validate", "--json"]));
			const document = json(result.stdout);

			expect(result.code).toBe(1);
			expect(result.stderr).toBe("");
			expect(document.valid).toBe(false);
			expect(document.issues[0]).toMatchObject({ tag: "DuplicateVersion", subject: "1.0.0" });
		}),
	);
});

describe("plan", () => {
	it.effect("prints the planned instructions and suggests a dry run", () =>
		Effect.gen(function* () {
			const result = yield* run(["plan", "--from", "1.0.0", "--to", "2.0.0"]);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain("@acme/widgets 1.0.0 -> 2.0.0 (upgrade)");
			expect(result.stdout).toContain("1.0.0-to-2.0.0/rename-timeout");
			expect(result.stdout).toContain('In config, rename "timeout" to "requestTimeout"');
			expect(result.stderr).toContain(
				'widgets-migrate migrate --from 1.0.0 --to 2.0.0 --route "1.0.0>2.0.0" --dry-run',
			);
		}),
	);

	it.effect("prints one JSON document and keeps diagnostics off stderr", () =>
		Effect.gen(function* () {
			const result = yield* run(["plan", "--from", "1.0.0", "--to", "2.0.0", "--json"]);
			const { plan } = json(result.stdout);

			expect(result.stderr).toBe("");
			expect(plan.route).toBe("1.0.0>2.0.0");
			expect(plan.steps).toEqual([
				{
					migration: "1.0.0-to-2.0.0",
					direction: "forward",
					from: "1.0.0",
					to: "2.0.0",
					omitted: false,
					occurrences: ["1.0.0-to-2.0.0/rename-timeout"],
				},
			]);
			expect(plan.occurrences[0]).toMatchObject({
				action: "rename-timeout",
				kind: "config.rename",
				origin: { type: "declared" },
			});
			expect(plan.occurrences[0]).not.toHaveProperty("payload");
			expect(plan.changes).toEqual([
				expect.objectContaining({
					id: "2026-11-06.rename-timeout",
					kind: "changed",
					breaking: true,
				}),
			]);
		}),
	);

	it.effect("asks the caller to choose between routes, with commands to run", () =>
		Effect.gen(function* () {
			const machine = yield* run(["plan", "--from", "1.0.0", "--to", "3.0.0", "--json"]);
			const human = yield* run(["plan", "--from", "1.0.0", "--to", "3.0.0"]);
			const document = json(machine.stderr);

			expect(machine.code).toBe(2);
			expect(machine.stdout).toBe("");
			expect(document).toMatchObject({
				status: "action_required",
				reason: "ambiguous_route",
			});
			expect(
				document.data.candidates.map((candidate: { id: string }) => candidate.id),
			).toEqual(["1.0.0>2.0.0>3.0.0", "1.0.0>[fast-upgrade]>3.0.0"]);
			expect(document.data.policies).toContain("prefer-shortcuts");
			expect(document.next[0].argv).toEqual([
				"widgets-migrate",
				"plan",
				"--from",
				"1.0.0",
				"--to",
				"3.0.0",
				"--route",
				"1.0.0>2.0.0>3.0.0",
				"--json",
			]);
			expect(human.stderr).toContain('--route "1.0.0>[fast-upgrade]>3.0.0"');
		}),
	);

	it.effect("follows a chosen route or policy exactly", () =>
		Effect.gen(function* () {
			const byRoute = yield* run([
				"plan",
				"--from",
				"1.0.0",
				"--to",
				"3.0.0",
				"--route",
				"1.0.0>[fast-upgrade]>3.0.0",
				"--json",
			]);
			const byPolicy = yield* run([
				"plan",
				"--from",
				"1.0.0",
				"--to",
				"3.0.0",
				"--policy",
				"fewest-migrations",
				"--json",
			]);

			expect(json(byRoute.stdout).plan.route).toBe("1.0.0>[fast-upgrade]>3.0.0");
			expect(json(byPolicy.stdout).plan.route).toBe("1.0.0>[fast-upgrade]>3.0.0");
		}),
	);

	it.effect("reports an unsupported route with the closest reachable versions", () =>
		Effect.gen(function* () {
			const result = yield* run(["plan", "--from", "3.0.0", "--to", "4.0.0", "--json"]);
			const document = json(result.stderr);

			expect(result.code).toBe(1);
			expect(document.reason).toBe("unsupported_route");
			expect(document.data.blockers).toEqual([
				expect.objectContaining({ from: "3.0.0", to: "4.0.0" }),
			]);
			expect(document.next[0].argv.slice(1, 4)).toEqual(["upgrades", "--from", "3.0.0"]);
		}),
	);

	it.effect("treats unknown versions and routes as caller input (exit 2)", () =>
		Effect.gen(function* () {
			const version = yield* run(["plan", "--from", "1.0.0", "--to", "9.9.9", "--json"]);
			const route = yield* run([
				"plan",
				"--from",
				"1.0.0",
				"--to",
				"3.0.0",
				"--route",
				"nope",
				"--json",
			]);

			expect(version.code).toBe(2);
			expect(json(version.stderr).data).toEqual({
				version: "9.9.9",
				known: ["1.0.0", "2.0.0", "3.0.0", "4.0.0"],
			});
			expect(route.code).toBe(2);
			expect(json(route.stderr).reason).toBe("unknown_route");
		}),
	);
});

describe("upgrades and downgrades", () => {
	it.effect("list destinations with their routes", () =>
		Effect.gen(function* () {
			const human = yield* run(["upgrades", "--from", "1.0.0"]);
			const machine = yield* run(["upgrades", "--from", "1.0.0", "--json"]);
			const none = yield* run(["downgrades", "--from", "1.0.0"]);

			expect(human.stdout).toContain("Upgrades from 1.0.0");
			expect(json(machine.stdout).destinations).toEqual([
				{ version: "2.0.0", routes: ["1.0.0>2.0.0"] },
				{ version: "3.0.0", routes: ["1.0.0>2.0.0>3.0.0", "1.0.0>[fast-upgrade]>3.0.0"] },
			]);
			expect(none.code).toBe(0);
			expect(none.stdout).toBe("No downgrades from 1.0.0\n");
		}),
	);
});

/** Runs `migrate` until its first action starts, then interrupts the CLI fiber. */
const interrupted = (extra: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const cli = Command.make(widgets, {
			name: "widgets-migrate",
			handlers: [
				Handler.effect(renameTimeout, () =>
					Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
				),
			],
		});
		const io = terminal();
		const fiber = yield* Effect.forkChild(
			io.provide(start(cli, ["migrate", "--from", "1.0.0", "--to", "2.0.0", ...extra])),
		);
		yield* Deferred.await(started);
		yield* Fiber.interrupt(fiber);
		const exit = yield* Fiber.await(fiber);

		return { code: exitCode(exit), stdout: io.stdout(), stderr: io.stderr() };
	});

describe("migrate", () => {
	it.effect("runs the plan and prints the report", () =>
		Effect.gen(function* () {
			const calls: Calls = [];
			const result = yield* run(
				["migrate", "--from", "1.0.0", "--to", "2.0.0", "--json"],
				{},
				calls,
			);
			const { report } = json(result.stdout);

			expect(result.code).toBe(0);
			expect(calls).toEqual(["check rename-timeout", "rename-timeout"]);
			expect(report).toMatchObject({
				mode: "execute",
				status: "completed",
				bodiesStarted: true,
				persistence: "none",
				unsettled: [],
			});
			expect(report.summary.completed).toBe(1);
		}),
	);

	it.effect("keeps the dry-run report on stdout when diagnostics are silenced", () =>
		Effect.gen(function* () {
			const calls: Calls = [];
			const result = yield* run(
				[
					"migrate",
					"--from",
					"1.0.0",
					"--to",
					"2.0.0",
					"--dry-run",
					"--json",
					"--log-level",
					"none",
				],
				{},
				calls,
			);
			const { report } = json(result.stdout);

			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(calls).toEqual(["check rename-timeout"]);
			expect(report).toMatchObject({
				mode: "dry-run",
				status: "would-complete",
				bodiesStarted: false,
			});
			expect(report.occurrences[0].outcome).toEqual({
				status: "would-execute",
				evaluated: true,
			});
		}),
	);

	it.effect("reports a partial failure without claiming a rollback", () =>
		Effect.gen(function* () {
			const calls: Calls = [];
			const options = { failAddRetries: true };
			const cli = migrator(calls, options).cli;
			const argv = [
				"migrate",
				"--from",
				"1.0.0",
				"--to",
				"3.0.0",
				"--route",
				"1.0.0>2.0.0>3.0.0",
			];
			const machine = yield* capture(start(cli, [...argv, "--json"]));
			const human = yield* capture(start(cli, argv));
			const { report } = json(machine.stdout);

			expect(machine.code).toBe(1);
			expect(report.status).toBe("failed");
			expect(report.summary).toMatchObject({ completed: 1, failed: 1 });
			expect(report.occurrences[1].outcome).toMatchObject({
				status: "failed",
				phase: "body",
				error: { tag: "UnexpectedHandlerError", cause: { code: "EACCES" } },
			});
			expect(human.code).toBe(1);
			expect(human.stdout).toContain("Migration from 1.0.0 to 3.0.0 failed");
			expect(human.stdout).toContain("Completed actions were not rolled back");
			expect(human.stderr).toContain("Running 2 actions in 2 migrations");
		}),
	);

	it.effect("reports missing handlers before any precondition runs", () =>
		Effect.gen(function* () {
			const calls: Calls = [];
			const cli = Command.make(widgets, {
				name: "widgets-migrate",
				handlers: () => handlersFor(calls).slice(1),
			});
			const result = yield* capture(
				start(cli, ["migrate", "--from", "1.0.0", "--to", "2.0.0", "--json"]),
			);
			const document = json(result.stderr);

			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(calls).toEqual([]);
			expect(document.reason).toBe("handler_coverage");
			expect(document.data.issues[0]).toMatchObject({
				tag: "Missing",
				action: "rename-timeout",
				occurrence: "1.0.0-to-2.0.0/rename-timeout",
			});
		}),
	);

	it.effect("reports handlers that fail to load", () =>
		Effect.gen(function* () {
			const cli = Command.make(widgets, {
				name: "widgets-migrate",
				handlers: () => Promise.reject(new Error("Cannot find module './handlers.js'")),
			});
			const result = yield* capture(
				start(cli, ["migrate", "--from", "1.0.0", "--to", "2.0.0", "--json"]),
			);

			expect(result.code).toBe(1);
			expect(json(result.stderr)).toMatchObject({
				reason: "handlers_load_failed",
				data: { error: { message: "Cannot find module './handlers.js'" } },
			});
		}),
	);

	it.effect("rejects an invalid duration as a usage error", () =>
		Effect.gen(function* () {
			const result = yield* run([
				"migrate",
				"--from",
				"1.0.0",
				"--to",
				"2.0.0",
				"--action-timeout",
				"soon",
			]);

			expect(result.code).toBe(2);
			expect(result.stderr).toContain("Expected a duration such as 500ms, 30s, or 2m");
		}),
	);

	it.live("stops an action that exceeds --action-timeout", () =>
		Effect.gen(function* () {
			const cli = Command.make(widgets, {
				name: "widgets-migrate",
				handlers: [Handler.effect(renameTimeout, () => Effect.never)],
			});
			const result = yield* capture(
				start(cli, [
					"migrate",
					"--from",
					"1.0.0",
					"--to",
					"2.0.0",
					"--action-timeout",
					"20ms",
					"--json",
				]),
			);
			const { report } = json(result.stdout);

			expect(result.code).toBe(1);
			expect(report.status).toBe("interrupted");
			expect(report.occurrences[0].outcome).toMatchObject({
				status: "interrupted",
				reason: "timeout",
				settled: true,
			});
		}),
	);

	it.live("prints the partial report when interrupted and exits as interrupted", () =>
		Effect.gen(function* () {
			const machine = yield* interrupted(["--json"]);
			const human = yield* interrupted([]);
			const { report } = json(machine.stdout);

			expect(machine.code).toBe(130);
			expect(machine.stderr).toBe("");
			expect(report.status).toBe("interrupted");
			expect(report.occurrences[0].outcome).toMatchObject({
				status: "interrupted",
				reason: "cancelled",
				settled: true,
			});
			expect(human.code).toBe(130);
			expect(human.stdout).toContain("Migration from 1.0.0 to 2.0.0 was interrupted");
			expect(human.stderr).toContain("Canceled.");
		}),
	);

	it.effect("keeps handler logs off stdout", () =>
		Effect.gen(function* () {
			const cli = Command.make(widgets, {
				name: "widgets-migrate",
				handlers: [Handler.effect(renameTimeout, () => Effect.log("renaming"))],
			});
			const result = yield* capture(
				start(cli, ["migrate", "--from", "1.0.0", "--to", "2.0.0", "--json"]),
			);

			expect(json(result.stdout).report.status).toBe("completed");
			expect(result.stderr).toContain("renaming");
		}),
	);
});

describe("documents", () => {
	it.effect("prints the guide as Markdown", () =>
		Effect.gen(function* () {
			const result = yield* run(["guide", "--from", "1.0.0", "--to", "2.0.0"]);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain("Upgrade");
			expect(result.stdout).toContain("rename");
		}),
	);

	it.effect("writes a document to --output", () =>
		Effect.gen(function* () {
			const result = yield* run([
				"guide",
				"--from",
				"1.0.0",
				"--to",
				"2.0.0",
				"--format",
				"html",
				"--output",
				"guide.html",
				"--json",
			]);

			expect(result.code).toBe(0);
			expect(json(result.stdout).document).toEqual({
				kind: "guide",
				format: "html",
				path: "guide.html",
			});
			expect(result.files.get("guide.html")).toContain("<h1>");
		}),
	);

	it.effect("renders the history or one release from the supplied metadata", () =>
		Effect.gen(function* () {
			const history = yield* run(["changelog"]);
			const release = yield* run(["changelog", "--release", "2.0.0", "--json"]);
			const missing = yield* run(["changelog", "--release", "9.0.0", "--json"]);

			expect(history.stdout).toContain("@acme/widgets");
			expect(json(release.stdout).document.content).toContain("2.0.0");
			expect(missing.code).toBe(2);
			expect(json(missing.stderr).reason).toBe("unknown_version");
		}),
	);
});

describe("presentation", () => {
	it.effect("uses color only when allowed", () =>
		Effect.gen(function* () {
			const argv = ["upgrades", "--from", "1.0.0"];
			const terminalOut = yield* run(argv, { stdoutIsTerminal: true });
			const forced = yield* run(argv, { env: { FORCE_COLOR: "1" } });
			const noColor = yield* run(argv, { stdoutIsTerminal: true, env: { NO_COLOR: "1" } });
			const flag = yield* run([...argv, "--no-color"], { stdoutIsTerminal: true });
			const dumb = yield* run(argv, { stdoutIsTerminal: true, env: { TERM: "dumb" } });
			const machine = yield* run([...argv, "--json"], {
				stdoutIsTerminal: true,
				env: { FORCE_COLOR: "1" },
			});

			expect(terminalOut.stdout).toContain(ansi);
			expect(forced.stdout).toContain(ansi);
			expect(noColor.stdout).not.toContain(ansi);
			expect(flag.stdout).not.toContain(ansi);
			expect(dumb.stdout).not.toContain(ansi);
			expect(machine.stdout).not.toContain(ansi);
		}),
	);

	it.effect("keeps failures visible at any log level", () =>
		Effect.gen(function* () {
			const failed = yield* run([
				"plan",
				"--from",
				"1.0.0",
				"--to",
				"9.9.9",
				"--log-level",
				"none",
			]);
			const planned = yield* run([
				"plan",
				"--from",
				"1.0.0",
				"--to",
				"2.0.0",
				"--log-level",
				"none",
			]);

			expect(failed.code).toBe(2);
			expect(failed.stderr).toContain('Version "9.9.9" is not registered');
			expect(planned.stdout).toContain("1.0.0-to-2.0.0/rename-timeout");
			expect(planned.stderr).toBe("");
		}),
	);
});

describe("composition", () => {
	it.effect("mounts several package commands under one command", () =>
		Effect.gen(function* () {
			const gadgets = Command.make(widgets, { name: "gadgets" });
			const acme = EffectCli.Command.make("acme").pipe(
				EffectCli.Command.withSubcommands([migrator().cli, gadgets]),
			);
			const plan = yield* capture(
				Cli.run(acme, {
					version: "1.0.0",
					argv: ["widgets-migrate", "plan", "--from", "1.0.0", "--to", "2.0.0", "--json"],
				}),
			);
			const help = yield* capture(
				Cli.run(acme, { version: "1.0.0", argv: ["gadgets", "plan", "--help"] }),
			);
			const unknown = yield* capture(
				Cli.run(acme, {
					version: "1.0.0",
					argv: ["gadgets", "plan", "--frm", "1.0.0", "--json"],
				}),
			);

			expect(json(plan.stdout).plan.route).toBe("1.0.0>2.0.0");
			expect(help.stdout).toContain("acme gadgets plan --from 1.0.0 --to 2.0.0");
			expect(unknown.code).toBe(2);
			expect(json(unknown.stderr).reason).toBe("unknown_option");
		}),
	);
});

describe("types", () => {
	it("rejects handlers for actions outside the package", () => {
		expect.assertions(0);
		const foreign = Handler.promise(restoreTimeout, async () => {});
		typeOnly(() => {
			// @ts-expect-error restore-timeout is not an action of the widgets history.
			Command.make(widgets, { name: "x", handlers: [foreign] });
		});
	});

	it("requires the handlers' services from the caller", () => {
		const Files = Context.Service<{ readonly write: () => Effect.Effect<void> }>("test/Files");
		const cli = Command.make(widgets, {
			name: "x",
			handlers: [
				Handler.effect(renameTimeout, () =>
					Effect.gen(function* () {
						const files = yield* Files;
						yield* files.write();
					}),
				),
			],
		});

		expectTypeOf(Cli.run(cli, { version: "0" })).toEqualTypeOf<
			Effect.Effect<
				void,
				Command.CliFailure,
				Context.Service.Identifier<typeof Files> | EffectCli.Command.Environment
			>
		>();
	});
});
