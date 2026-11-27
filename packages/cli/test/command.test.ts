import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, Layer, Runtime, Sink, Stdio } from "effect";
import { TestConsole } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import { Cli } from "deltafold/cli";
import { root } from "../src/command.ts";

const collect = (target: Array<string>) => () =>
	Sink.forEach((chunk: string | Uint8Array) =>
		Effect.sync(() => {
			target.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		}),
	);

/** Runs the `deltafold` command in process and returns its output and exit code. */
const run = (argv: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const stdout: Array<string> = [];
		const stderr: Array<string> = [];
		const exit = yield* Effect.exit(
			Cli.run(root, { version: "0.0.0", argv }).pipe(
				// Each test runs the command as its own program.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(
					Layer.mergeAll(
						Stdio.layerTest({ stdout: collect(stdout), stderr: collect(stderr) }),
						TestConsole.layer,
					).pipe(Layer.provideMerge(NodeServices.layer)),
				),
			),
		);
		let code = -1;
		Runtime.defaultTeardown(exit, (value) => {
			code = value;
		});

		return { exit, code, stdout: stdout.join(""), stderr: stderr.join("") };
	});

/** Runs `--help` and returns the printed help. */
const help = (argv: ReadonlyArray<string>) =>
	Cli.run(root, { version: "0.0.0", argv: [...argv, "--help"] }).pipe(
		Effect.andThen(TestConsole.logLines),
		Effect.map((lines) => lines.join("\n")),
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(Layer.provideMerge(TestConsole.layer, NodeServices.layer)),
	);

const json = (text: string) => {
	const lines = text.split("\n").filter((line) => line !== "");
	expect(lines).toHaveLength(1);

	return JSON.parse(lines[0] ?? "");
};

describe("deltafold", () => {
	it("lists self in help, with examples under the full command path", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const top = yield* help([]);
				const plan = yield* help(["self", "plan"]);

				expect(top).toContain("self");
				expect(top).toContain(
					"Plan and run migrations between versions of the deltafold library",
				);
				expect(plan).toContain("deltafold self plan --from 1.0.0 --to 2.0.0");
			}),
		));

	it("validates deltafold's own history", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* run(["self", "validate", "--json"]);

				expect(Exit.isSuccess(result.exit)).toBe(true);
				expect(json(result.stdout)).toMatchObject({ package: "deltafold", valid: true });
			}),
		));

	it("suggests the full command path after a usage error", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const human = yield* run(["self", "plan", "--frm", "0.0.0"]);
				const machine = yield* run(["self", "plan", "--frm", "0.0.0", "--json"]);

				expect(human.code).toBe(2);
				expect(human.stdout).toBe("");
				expect(human.stderr).toContain("deltafold self plan --help");
				expect(json(machine.stderr).next[0].argv).toEqual([
					"deltafold",
					"self",
					"plan",
					"--help",
				]);
			}),
		));

	it("reports an unknown version as one JSON error document", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* run([
					"self",
					"plan",
					"--from",
					"0.0.0",
					"--to",
					"9.0.0",
					"--json",
				]);

				expect(result.code).toBe(2);
				expect(result.stdout).toBe("");
				expect(json(result.stderr)).toMatchObject({
					reason: "unknown_version",
					data: { known: ["0.0.0"] },
				});
			}),
		));
});
