// Keeps the package README examples working. The in-memory file map stands in for the
// consumer's own file access.
import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { Action, Change, Executor, Handler, History, Migration, Package, Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";

const files = new Map<string, Record<string, unknown>>();

const renameKey = async (
	file: string,
	from: string,
	to: string,
	_options: { signal: AbortSignal },
) => {
	const config = files.get(file);
	if (config === undefined || !(from in config)) throw new Error(`${file} has no "${from}" key`);
	const { [from]: value, ...rest } = config;
	files.set(file, { ...rest, [to]: value });
};

// Declarations, as a package author writes them.
const RenameKey = Action.define<{ file: string; from: string; to: string }>("config.rename", {
	describe: ({ file, from, to }) => `In ${file}, rename "${from}" to "${to}"`,
});

const renameTimeout = RenameKey.make("rename-timeout", {
	file: "app.json",
	from: "timeout",
	to: "requestTimeout",
});

const timeoutRenamed = Change.make("2026-11-06.rename-timeout", {
	kind: "changed",
	breaking: true,
})`
	Rename the timeout option to requestTimeout.
`;

const v1 = Version.make("1.0.0", { changes: [] });
const v2 = Version.make("2.0.0", { previous: v1, changes: [timeoutRenamed] });

const toV2 = Migration.make("1.0.0-to-2.0.0", { from: v1, to: v2, addresses: [timeoutRenamed] })`
	${Migration.instruction(renameTimeout)`Rename the timeout option. Its value stays in milliseconds.`}
`;

const history = History.make({ versions: [v1, v2], migrations: [toV2] });
const widgets = Package.make("@acme/widgets", { history });

// Consumer code.
const handlers = [
	Handler.promise(
		renameTimeout,
		async ({ file, from, to }, { signal }) => {
			await renameKey(file, from, to, { signal });
		},
		{
			when: ({ file }) => files.has(file),
			skipReason: "This project has no app.json",
		},
	),
];

const migrate = async (from: string, to: string) => {
	const resolved = History.resolve(history, { from, to });
	if (Result.isFailure(resolved)) throw new Error(resolved.failure.message);

	try {
		const report = await Executor.runPromise(resolved.success, { handlers });

		return report.occurrences.map((entry) => `${entry.occurrence.id}: ${entry.outcome._tag}`);
	} catch (error) {
		if (error instanceof Executor.ExecutionFailed) {
			return error.report.occurrences.map(
				(entry) => `${entry.occurrence.id}: ${entry.outcome._tag}`,
			);
		}
		throw error;
	}
};

describe("README examples", () => {
	it("runs the Promise example", async () => {
		files.set("app.json", { timeout: 5000 });

		expect(await migrate("1.0.0", "2.0.0")).toEqual([
			"1.0.0-to-2.0.0/rename-timeout: Completed",
		]);
		expect(files.get("app.json")).toEqual({ requestTimeout: 5000 });
		expect(await migrate("1.0.0", "2.0.0")).toEqual(["1.0.0-to-2.0.0/rename-timeout: Failed"]);

		files.clear();
		expect(await migrate("1.0.0", "2.0.0")).toEqual(["1.0.0-to-2.0.0/rename-timeout: Skipped"]);
		await expect(migrate("2.0.0", "1.0.0")).rejects.toThrow(
			'No declared downgrade route from "2.0.0" to "1.0.0".',
		);
	});

	it("renders the guide and the changelog", () => {
		const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
		if (Result.isFailure(resolved)) throw resolved.failure;
		const changelog = Changelog.make<{ readonly date: string }>();

		expect(Markdown.render(changelog.upgrade(resolved.success, { package: widgets }))).toBe(
			"# Upgrade @acme/widgets from 1.0.0 to 2.0.0\n\n## 1.0.0 to 2.0.0\n\nRename the timeout option. Its value stays in milliseconds.\n",
		);
		expect(
			Markdown.render(
				changelog.history(widgets, {
					releases: [
						Version.withMetadata(v1, { date: "2026-10-01" }),
						Version.withMetadata(v2, { date: "2026-11-06" }),
					],
				}),
			),
		).toBe(
			"# @acme/widgets\n\n## 2.0.0\n\n### Breaking changes\n\n- Rename the timeout option to requestTimeout.\n\n## 1.0.0\n",
		);
	});
});
