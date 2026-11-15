import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect";
import * as EffectCli from "effect/cli";

import { Action, Change, Handler, History, Migration, Observer, Package, Version } from "deltafold";
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
	Handler.promise(renameTimeout, {
		prepare: async () => {
			calls.push("prepare rename-timeout");

			return Handler.prepared();
		},
		apply: async () => {
			calls.push("rename-timeout");
		},
	}),
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
					id: "1.0.0-to-2.0.0",
					migration: "1.0.0-to-2.0.0",
					direction: "forward",
					from: "1.0.0",
					to: "2.0.0",
					omitted: false,
					occurrences: ["1.0.0-to-2.0.0/rename-timeout"],
				},
			]);
			expect(plan.occurrences[0]).toMatchObject({
				step: "1.0.0-to-2.0.0",
				action: "rename-timeout",
				kind: "config.rename",
				origin: { type: "declared" },
			});
			expect(plan.occurrences[0]).not.toHaveProperty("payload");
			expect(plan.changes).toEqual([
				{
					id: "2026-11-06.rename-timeout",
					description: "Rename the timeout configuration option to requestTimeout.",
					metadata: { kind: "changed", breaking: true },
					reverts: [],
					backportOf: null,
				},
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

describe("change metadata", () => {
	it.effect("keeps every key and names values that JSON cannot hold", () =>
		Effect.gen(function* () {
			const nested: Record<string, unknown> = { team: "config" };
			nested["self"] = nested;
			const noted = Change.define<Record<string, unknown>>().make("2026-11-15.noted", {
				breaking: true,
				ticket: "ACME-42",
				labels: ["config", 2, false, null],
				releasedAt: new Date(0),
				owners: new Set(["a"]),
				size: 10n,
				render: () => "x",
				ratio: Number.NaN,
				unset: undefined,
				nested,
			})`Note the change.`;
			const later = Version.make("2.0.0", { previous: v1, changes: [noted] });
			const step = Migration.make("1.0.0-to-2.0.0", {
				from: v1,
				to: later,
				addresses: [noted],
			})`${renameTimeout}`;
			const pkg = Package.make("@acme/noted", {
				history: History.make({ versions: [v1, later], migrations: [step] }),
			});
			const result = yield* capture(
				start(Command.make(pkg), ["plan", "--from", "1.0.0", "--to", "2.0.0", "--json"]),
			);

			expect(json(result.stdout).plan.changes[0].metadata).toEqual({
				breaking: true,
				ticket: "ACME-42",
				labels: ["config", 2, false, null],
				releasedAt: "[Date]",
				owners: "[Set]",
				size: "[BigInt]",
				render: "[Function]",
				ratio: "[NaN]",
				unset: null,
				nested: { team: "config", self: "[Circular]" },
			});
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
			expect(calls).toEqual(["prepare rename-timeout", "rename-timeout"]);
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
			expect(calls).toEqual(["prepare rename-timeout"]);
			expect(report).toMatchObject({
				mode: "dry-run",
				status: "would-complete",
				bodiesStarted: false,
			});
			expect(report.occurrences[0].outcome).toEqual({
				status: "would-execute",
				evaluated: true,
				performer: "automated",
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
				phase: "apply",
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

	it.effect("reports a failed prepare phase by mode", () =>
		Effect.gen(function* () {
			const command = Command.make(widgets, {
				handlers: [
					Handler.promise(renameTimeout, {
						prepare: async () => {
							throw new Error("config unreadable");
						},
						apply: async () => {},
					}),
				],
			});
			const argv = ["migrate", "--from", "1.0.0", "--to", "2.0.0"];
			const real = yield* capture(start(command, [...argv, "--json"]));
			const dry = yield* capture(start(command, [...argv, "--dry-run", "--json"]));
			const human = yield* capture(start(command, [...argv, "--dry-run"]));
			const error = {
				tag: "UnexpectedHandlerError",
				cause: { message: "config unreadable" },
			};

			expect(real.code).toBe(1);
			expect(json(real.stdout).report.occurrences[0].outcome).toMatchObject({
				status: "failed",
				phase: "prepare",
				error,
			});
			expect(dry.code).toBe(1);
			expect(json(dry.stdout).report.occurrences[0].outcome).toMatchObject({
				status: "preparation-failed",
				error,
			});
			expect(human.stdout).toContain("preparation failed");
			expect(human.stdout).toContain("Dry run from 1.0.0 to 2.0.0: a prepare phase failed");
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

	it.effect("keeps execution limits in suggested route commands", () =>
		Effect.gen(function* () {
			const result = yield* run([
				"migrate",
				"--from",
				"1.0.0",
				"--to",
				"3.0.0",
				"--action-timeout",
				"1s",
				"--settle-timeout",
				"500ms",
				"--json",
			]);
			const { argv } = json(result.stderr).next[0];

			expect(result.code).toBe(2);
			expect(argv).toEqual(
				expect.arrayContaining(["--action-timeout", "1000ms", "--settle-timeout", "500ms"]),
			);
		}),
	);

	it.live("prints the failed run's report when an interruption follows a failure", () =>
		Effect.gen(function* () {
			const failed = yield* Deferred.make<void>();
			const both = Migration.make("1.0.0-to-2.0.0", { from: v1, to: v2 })`${Action.parallel([
				renameTimeout,
				addRetryLimit,
			])}`;
			const pkg = Package.make("@acme/parallel", {
				history: History.make({ versions: [v1, v2], migrations: [both] }),
			}).pipe(
				Package.withObserver(
					Observer.effect((event) =>
						event._tag === "ActionSettled" && event.outcome._tag === "Failed"
							? Deferred.succeed(failed, undefined)
							: Effect.void,
					),
				),
			);
			const command = Command.make(pkg, {
				handlers: [
					Handler.effect(renameTimeout, () => Effect.never),
					Handler.promise(addRetryLimit, async () => {
						throw new Error("disk full");
					}),
				],
			});
			const io = terminal();
			const fiber = yield* Effect.forkChild(
				io.provide(
					start(command, ["migrate", "--from", "1.0.0", "--to", "2.0.0", "--json"]),
				),
			);
			yield* Deferred.await(failed);
			yield* Fiber.interrupt(fiber);
			const exit = yield* Fiber.await(fiber);
			const { report } = json(io.stdout());

			expect(exitCode(exit)).toBe(130);
			expect(report.status).toBe("failed");
			expect(report.summary).toMatchObject({ failed: 1, interrupted: 1 });
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

/** The reason of the CLI failure an exit ended with, if any. */
const failureReason = (exit: Exit.Exit<unknown, unknown>) => {
	if (Exit.isSuccess(exit)) return undefined;
	const error = Cause.squash(exit.cause);

	return error instanceof Command.CliFailure ? error.reason : undefined;
};

const person = { stdinIsTerminal: true, stderrIsTerminal: true } as const;

/** A migrator whose only handler is manual. */
const manualMigrator = () =>
	Command.make(widgets, { name: "widgets-migrate", handlers: [Handler.manual(renameTimeout)] });

/**
 * A manual rename beside an automated retry limit, in parallel branches. `checks` records
 * the automated prepare phase, which shows whether anything ran.
 */
const mixedMigrator = (checks: Calls) =>
	Command.make(parallel([renameTimeout, addRetryLimit]), {
		name: "widgets-migrate",
		handlers: [
			Handler.manual(renameTimeout),
			Handler.promise(addRetryLimit, {
				prepare: async () => {
					checks.push("prepare add-retry-limit");

					return Handler.prepared();
				},
				apply: async () => {},
			}),
		],
	});

describe("manual handlers", () => {
	const argv = ["migrate", "--from", "1.0.0", "--to", "2.0.0"];

	it.effect("asks a person at a terminal and records the confirmation", () =>
		Effect.gen(function* () {
			const result = yield* capture(start(manualMigrator(), argv), {
				...person,
				input: ["maybe", "constructor", "y"],
			});

			expect(result.code).toBe(0);
			expect(result.stderr).toContain("Manual step 1.0.0-to-2.0.0/rename-timeout");
			expect(result.stderr).toContain('In config, rename "timeout" to "requestTimeout"');
			expect(result.stderr).toContain("Did you complete it? (y/n) maybe\nAnswer y or n.");
			expect(result.stderr).toContain(
				"Did you complete it? (y/n) constructor\nAnswer y or n.",
			);
			expect(result.stdout).toContain(
				"1.0.0-to-2.0.0/rename-timeout (confirmed by a person)",
			);
			expect(result.stdout).not.toContain("maybe");
		}),
	);

	it.effect("shows the migration's instruction for the action", () =>
		Effect.gen(function* () {
			const step = Migration.make("1.0.0-to-2.0.0", { from: v1, to: v2 })`
				${Migration.instruction(renameTimeout)`Rename the key in every environment's config.`}
			`;
			const pkg = Package.make("@acme/instructed", {
				history: History.make({ versions: [v1, v2], migrations: [step] }),
			});
			const command = Command.make(pkg, { handlers: [Handler.manual(renameTimeout)] });
			const result = yield* capture(start(command, argv), { ...person, input: ["yes"] });

			expect(result.code).toBe(0);
			expect(result.stderr).toContain("  Rename the key in every environment's config.");
		}),
	);

	it.effect("stops the run when the person declines", () =>
		Effect.gen(function* () {
			const result = yield* capture(start(manualMigrator(), argv), {
				...person,
				input: ["n"],
			});

			expect(result.code).toBe(1);
			expect(failureReason(result.exit)).toBe("manual_work_declined");
			expect(result.stdout).toContain(
				"Declined manual work stopped the run: 1.0.0-to-2.0.0/rename-timeout.",
			);
		}),
	);

	it.effect("cancels the run at the end of input instead of declining", () =>
		Effect.gen(function* () {
			const result = yield* capture(start(manualMigrator(), argv), { ...person, input: [] });

			expect(result.code).toBe(130);
			expect(result.stdout).toContain(
				"1.0.0-to-2.0.0/rename-timeout (confirmation, cancelled)",
			);
			expect(result.stdout).not.toContain("declined");
			expect(result.stderr).toContain("Canceled.");
		}),
	);

	it.effect("refuses to start without a person at a terminal", () =>
		Effect.gen(function* () {
			const checks: Calls = [];
			const machine = yield* capture(
				start(mixedMigrator(checks), [...argv, "--json"]),
				person,
			);
			const piped = yield* capture(start(mixedMigrator(checks), argv), {
				stdinIsTerminal: false,
				stderrIsTerminal: true,
			});
			const ci = yield* capture(start(mixedMigrator(checks), argv), {
				...person,
				env: { CI: "true" },
			});
			const document = json(machine.stderr);

			expect(machine.code).toBe(2);
			expect(machine.stdout).toBe("");
			expect(document).toMatchObject({
				status: "action_required",
				reason: "interaction_required",
			});
			expect(document.data.occurrences).toEqual([
				{
					id: "1.0.0-to-2.0.0/rename-timeout",
					action: "rename-timeout",
					kind: "config.rename",
					description: 'In config, rename "timeout" to "requestTimeout"',
					migration: "1.0.0-to-2.0.0",
				},
			]);
			expect(document.next[0].argv).toContain("--dry-run");
			expect(piped.code).toBe(2);
			expect(ci.code).toBe(2);
			expect(ci.stderr).toContain("need a person to confirm them in a terminal");
			expect(checks).toEqual([]);
		}),
	);

	it.effect("previews manual work in a dry run without asking", () =>
		Effect.gen(function* () {
			const checks: Calls = [];
			const result = yield* capture(
				start(mixedMigrator(checks), [...argv, "--dry-run", "--json"]),
			);

			const { occurrences } = json(result.stdout).report;
			const manual = occurrences.find(
				(entry: { readonly action: string }) => entry.action === "rename-timeout",
			);

			expect(result.code).toBe(0);
			expect(checks).toEqual(["prepare add-retry-limit"]);
			expect(manual.outcome).toEqual({
				status: "would-execute",
				evaluated: false,
				performer: "manual",
			});
		}),
	);

	it.effect("asks one prompt at a time when branches run in parallel", () =>
		Effect.gen(function* () {
			const both = Migration.make("1.0.0-to-2.0.0", { from: v1, to: v2 })`${Action.parallel([
				renameTimeout,
				addRetryLimit,
			])}`;
			const pkg = Package.make("@acme/parallel", {
				history: History.make({ versions: [v1, v2], migrations: [both] }),
			});
			const command = Command.make(pkg, {
				handlers: [Handler.manual(renameTimeout), Handler.manual(addRetryLimit)],
			});
			const result = yield* capture(start(command, argv), { ...person, input: ["y", "y"] });
			const first = result.stderr.indexOf("Manual step 1.0.0-to-2.0.0/rename-timeout");
			const firstAnswer = result.stderr.indexOf("Did you complete it? (y/n) y\n");
			const second = result.stderr.indexOf("Manual step 1.0.0-to-2.0.0/add-retry-limit");

			expect(result.code).toBe(0);
			expect(first).toBeGreaterThanOrEqual(0);
			expect(firstAnswer).toBeGreaterThan(first);
			expect(second).toBeGreaterThan(firstAnswer);
		}),
	);
});

/** A package whose only migration runs `steps` as parallel branches. */
const parallel = (steps: ReadonlyArray<Action.Any>) => {
	const step = Migration.make("1.0.0-to-2.0.0", {
		from: v1,
		to: v2,
	})`${Action.parallel(steps)}`;

	return Package.make("@acme/parallel", {
		history: History.make({ versions: [v1, v2], migrations: [step] }),
	});
};

describe("queued manual prompts", () => {
	const argv = ["migrate", "--from", "1.0.0", "--to", "2.0.0"];

	it.effect("say that a decline is stopping the run", () =>
		Effect.gen(function* () {
			const command = Command.make(parallel([renameTimeout, addRetryLimit]), {
				handlers: [Handler.manual(renameTimeout), Handler.manual(addRetryLimit)],
			});
			const result = yield* capture(start(command, argv), { ...person, input: ["n", "y"] });
			const second = result.stderr.indexOf("Manual step 1.0.0-to-2.0.0/add-retry-limit");
			const notice = result.stderr.indexOf(
				"The run is stopping: 1.0.0-to-2.0.0/rename-timeout was declined.",
			);

			expect(result.code).toBe(1);
			expect(second).toBeGreaterThanOrEqual(0);
			expect(notice).toBeGreaterThan(second);
			expect(result.stderr).toContain(
				"This step had already started; confirm only if you completed it.",
			);
			expect(result.stdout).toContain(
				"1.0.0-to-2.0.0/add-retry-limit (confirmed by a person)",
			);
		}),
	);

	it.live("say that a failure is stopping the run", () =>
		Effect.gen(function* () {
			const asked = new Set<string>();
			const bothAsked = yield* Deferred.make<void>();
			const failed = yield* Deferred.make<void>();
			const observed = parallel([renameTimeout, addRetryLimit, addBoth]).pipe(
				Package.withObserver(
					Observer.effect((event) => {
						if (event._tag === "ActionPhaseStarted" && event.phase === "confirmation") {
							asked.add(event.action.occurrence);

							return asked.size === 2
								? Deferred.succeed(bothAsked, undefined)
								: Effect.void;
						}

						return event._tag === "ActionSettled" && event.outcome._tag === "Failed"
							? Deferred.succeed(failed, undefined)
							: Effect.void;
					}),
				),
			);
			const command = Command.make(observed, {
				handlers: [
					Handler.manual(renameTimeout),
					Handler.manual(addRetryLimit),
					Handler.effect(addBoth, () =>
						Effect.andThen(
							Deferred.await(bothAsked),
							Effect.fail(new Error("disk full")),
						),
					),
				],
			});
			// The first answer comes after the failure has reached the CLI's own observer,
			// which runs after the package's.
			const afterFailure = Effect.andThen(Deferred.await(failed), Effect.sleep("50 millis"));
			const result = yield* capture(start(command, argv), {
				...person,
				input: [{ line: "y", after: afterFailure }, "y"],
			});
			const second = result.stderr.indexOf("Manual step 1.0.0-to-2.0.0/add-retry-limit");
			const notice = result.stderr.indexOf(
				"The run is stopping: 1.0.0-to-2.0.0/add-both failed.",
			);

			expect(result.code).toBe(1);
			expect(notice).toBeGreaterThan(second);
			expect(result.stderr.indexOf("The run is stopping")).toBeGreaterThan(second);
		}),
	);
});

describe("observers", () => {
	it.effect("forwards the package's observers and prints progress on stderr", () =>
		Effect.gen(function* () {
			const seen: Array<string> = [];
			const observed = widgets.pipe(
				Package.withObserver(Observer.sync((event) => void seen.push(event._tag))),
			);
			const command = Command.make(observed, {
				name: "widgets-migrate",
				handlers: () => handlersFor([]),
			});
			const argv = ["migrate", "--from", "1.0.0", "--to", "2.0.0"];
			const machine = yield* capture(start(command, [...argv, "--json"]));
			const machineEvents = [...seen];
			const human = yield* capture(start(command, argv));

			expect(machine.code).toBe(0);
			expect(machine.stderr).toBe("");
			expect(machineEvents).toEqual([
				"RunStarted",
				"StepStarted",
				"ActionPhaseStarted",
				"ActionPhaseStarted",
				"ActionSettled",
				"StepSettled",
				"RunFinished",
			]);
			expect(human.stderr).toContain("Step 1.0.0-to-2.0.0  1.0.0 -> 2.0.0");
			expect(human.stderr).toContain("1.0.0-to-2.0.0/rename-timeout [1/1]");
		}),
	);

	it.effect("reports observer failures without changing the outcome", () =>
		Effect.gen(function* () {
			const observed = widgets.pipe(
				Package.withObserver(
					Observer.sync((event) => {
						if (event._tag === "RunStarted") throw new Error("dashboard offline");
					}),
				),
			);
			const command = Command.make(observed, { handlers: () => handlersFor([]) });
			const argv = ["migrate", "--from", "1.0.0", "--to", "2.0.0"];
			const machine = yield* capture(start(command, [...argv, "--json"]));
			const human = yield* capture(start(command, argv));
			const { report } = json(machine.stdout);

			expect(machine.code).toBe(0);
			expect(report.status).toBe("completed");
			expect(report.observation).toEqual([
				{
					observer: 0,
					event: "RunStarted",
					seq: 0,
					reason: "failed",
					error: { tag: "Error", message: "dashboard offline", code: null },
				},
			]);
			expect(human.code).toBe(0);
			expect(human.stderr).toContain(
				"Warning: observer 0 failed on RunStarted (event 0): dashboard offline",
			);
		}),
	);

	it.effect("reports failure values that cannot be printed", () =>
		Effect.gen(function* () {
			// A wrapper whose cause refers back to itself must not recurse.
			const loop: { _tag: string; message: string; cause?: unknown } = {
				_tag: "UnexpectedHandlerError",
				message: "loop",
			};
			loop.cause = loop;
			const unprintable: object = Object.create(null);
			const observed = widgets.pipe(
				Package.withObserver(Observer.effect(() => Effect.fail(unprintable))),
				Package.withObserver(Observer.effect(() => Effect.fail(loop))),
			);
			const command = Command.make(observed, { handlers: () => handlersFor([]) });
			const argv = ["migrate", "--from", "1.0.0", "--to", "2.0.0"];
			const machine = yield* capture(start(command, [...argv, "--json"]));
			const human = yield* capture(start(command, argv));
			const { observation } = json(machine.stdout).report;

			expect(machine.code).toBe(0);
			expect(observation[0].error).toEqual({
				tag: "object",
				message: "Unprintable value",
				code: null,
			});
			expect(observation[1].error).toEqual({
				tag: "UnexpectedHandlerError",
				message: "loop",
				code: null,
				cause: { tag: "UnexpectedHandlerError", message: "loop", code: null },
			});
			expect(human.code).toBe(0);
			expect(human.stderr).toContain(
				"Warning: observer 0 failed on RunStarted (event 0): Unprintable value",
			);
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

describe("release metadata", () => {
	it.effect("reports a release metadata loader that throws", () =>
		Effect.gen(function* () {
			const command = Command.make(widgets, {
				releases: () => {
					throw new Error("metadata unavailable");
				},
			});
			const result = yield* capture(start(command, ["changelog", "--json"]));

			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(json(result.stderr)).toMatchObject({
				reason: "invalid_release_metadata",
				data: { error: { message: "metadata unavailable" } },
			});
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
			void Command.make(widgets, { name: "x", handlers: [foreign] });
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

	it("requires the services of the package's observers", () => {
		const Telemetry = Context.Service<{ readonly send: (tag: string) => Effect.Effect<void> }>(
			"test/Telemetry",
		);
		const observed = widgets.pipe(
			Package.withObserver(
				Observer.effect((event) =>
					Effect.gen(function* () {
						const telemetry = yield* Telemetry;
						yield* telemetry.send(event._tag);
					}),
				),
			),
		);

		expectTypeOf(Cli.run(Command.make(observed), { version: "0" })).toEqualTypeOf<
			Effect.Effect<
				void,
				Command.CliFailure,
				Context.Service.Identifier<typeof Telemetry> | EffectCli.Command.Environment
			>
		>();
	});
});
