import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const script = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const deltafold = script("../src/domains/node/bin.ts");
const widgets = script("./__fixtures__/widgets-bin.ts");

type Result = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

/**
 * Runs a bin from source in a Node.js process. `onStderr` sees stderr as it arrives and can
 * signal the process.
 */
const run = (
	bin: string,
	args: ReadonlyArray<string>,
	options: {
		readonly env?: Readonly<Record<string, string>>;
		readonly onStderr?: (text: string, signal: (name: NodeJS.Signals) => void) => void;
	} = {},
) =>
	new Promise<Result>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--no-warnings", "--conditions=@deltafold/dev.src", bin, ...args],
			{
				env: { ...process.env, NO_COLOR: "1", ...options.env },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
			options.onStderr?.(stderr, (name) => child.kill(name));
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});

const json = (text: string) => {
	const lines = text.split("\n").filter((line) => line !== "");
	expect(lines).toHaveLength(1);

	return JSON.parse(lines[0] ?? "");
};

describe("deltafold bin", () => {
	it("prints help on stdout and exits 0", async () => {
		const result = await run(deltafold, ["--help"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("validate");
		expect(result.stdout).toContain("Plan and run migrations between versions of deltafold");
	});

	it("validates deltafold's own history", async () => {
		const result = await run(deltafold, ["validate", "--json"]);

		expect(result.code).toBe(0);
		expect(json(result.stdout)).toMatchObject({ package: "deltafold", valid: true });
	});

	it("reports a usage error once on stderr with exit 2", async () => {
		const result = await run(deltafold, ["plan", "--frm", "0.0.0"]);

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr.startsWith("Error: Unrecognized flag: --frm")).toBe(true);
		expect(result.stderr).not.toContain("CliFailure");
	});

	it("prints only the JSON error document on stderr", async () => {
		const result = await run(deltafold, ["plan", "--from", "0.0.0", "--to", "9.0.0", "--json"]);

		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(json(result.stderr)).toMatchObject({
			reason: "unknown_version",
			data: { known: ["0.0.0"] },
		});
	});
});

describe("a package migrator bin", () => {
	it("runs a migration and prints the complete report", async () => {
		const result = await run(widgets, [
			"migrate",
			"--from",
			"1.0.0",
			"--to",
			"2.0.0",
			"--json",
		]);

		expect(result.code).toBe(0);
		expect(json(result.stdout).report).toMatchObject({
			status: "completed",
			summary: { completed: 1 },
		});
	});

	it("flushes the partial report before exiting 1", async () => {
		const result = await run(
			widgets,
			[
				"migrate",
				"--from",
				"1.0.0",
				"--to",
				"3.0.0",
				"--route",
				"1.0.0>2.0.0>3.0.0",
				"--json",
			],
			{ env: { WIDGETS_MODE: "fail" } },
		);

		expect(result.code).toBe(1);
		expect(json(result.stdout).report).toMatchObject({
			status: "failed",
			summary: { completed: 1, failed: 1 },
		});
	});

	it("suggests route commands whose argv runs as is", async () => {
		const ambiguous = await run(widgets, [
			"plan",
			"--from",
			"1.0.0",
			"--to",
			"3.0.0",
			"--json",
		]);
		const document = json(ambiguous.stderr);
		const [, ...argv] = document.next[1].argv;
		const chosen = await run(widgets, argv);

		expect(ambiguous.code).toBe(2);
		expect(chosen.code).toBe(0);
		expect(json(chosen.stdout).plan.route).toBe("1.0.0>[fast-upgrade]>3.0.0");
	});

	// Windows cannot deliver SIGINT to a child process: `kill` terminates it. Cancellation
	// itself is covered in deltafold's tests by interrupting the CLI fiber.
	it.skipIf(process.platform === "win32")(
		"cancels on SIGINT, prints the partial report, and exits 130",
		async () => {
			let sent = false;
			const result = await run(
				widgets,
				["migrate", "--from", "1.0.0", "--to", "2.0.0", "--json"],
				{
					env: { WIDGETS_MODE: "slow" },
					onStderr: (text, signal) => {
						if (!sent && text.includes("started")) {
							sent = true;
							signal("SIGINT");
						}
					},
				},
			);

			expect(result.code).toBe(130);
			expect(json(result.stdout).report.occurrences[0].outcome).toMatchObject({
				status: "interrupted",
				reason: "cancelled",
				settled: true,
			});
		},
	);
});
