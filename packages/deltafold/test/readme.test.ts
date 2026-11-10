// Keeps the package README examples working. The in-memory file map stands in for the
// consumer's own file access.
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Effect, Result } from "effect";

import {
	Action,
	Change,
	Executor,
	Handler,
	History,
	Interaction,
	Migration,
	Observer,
	Package,
	Rule,
	Version,
} from "deltafold";
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

const restoreTimeout = RenameKey.make("restore-timeout", {
	file: "app.json",
	from: "requestTimeout",
	to: "timeout",
});
const reversible = Migration.withRevert(toV2)`${restoreTimeout}`;

const history = History.make({ versions: [v1, v2], migrations: [toV2] });
const widgets = Package.make("@acme/widgets", { history });

// Effect handlers, as in the README. Both work on the in-memory file map.
const ConfigFiles = Context.Service<{
	readonly renameKey: (file: string, from: string, to: string) => Effect.Effect<void>;
}>("app/ConfigFiles");

const effectHandler = Handler.effect(renameTimeout, ({ file, from, to }) =>
	Effect.gen(function* () {
		const configFiles = yield* ConfigFiles;
		yield* configFiles.renameKey(file, from, to);
	}),
);

const AsyncConfigFiles = Context.Service<{
	readonly renameKey: (
		file: string,
		from: string,
		to: string,
		options: { readonly signal: AbortSignal },
	) => Promise<void>;
}>("app/AsyncConfigFiles");

const promiseHandler = Handler.promise(
	renameTimeout,
	({ file, from, to }, { files: configFiles, signal }) =>
		configFiles.renameKey(file, from, to, { signal }),
	{ services: { files: AsyncConfigFiles } },
);

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

	it.effect("runs the Effect example", () =>
		Effect.gen(function* () {
			files.set("app.json", { timeout: 5000 });
			const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
			if (Result.isFailure(resolved)) throw resolved.failure;
			const execution = Executor.effect(resolved.success, { handlers: [effectHandler] });
			expectTypeOf<Effect.Services<typeof execution>>().toEqualTypeOf<
				Context.Service.Identifier<typeof ConfigFiles>
			>();

			const report = yield* execution.pipe(
				Effect.provideService(ConfigFiles, {
					renameKey: (file, from, to) =>
						Effect.promise(() =>
							renameKey(file, from, to, { signal: new AbortController().signal }),
						),
				}),
			);

			expect(report.status).toBe("completed");
			expect(files.get("app.json")).toEqual({ requestTimeout: 5000 });
		}),
	);

	it("runs the Promise handler with declared services", async () => {
		files.set("app.json", { timeout: 5000 });
		const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
		if (Result.isFailure(resolved)) throw resolved.failure;

		const report = await Executor.runPromise(resolved.success, {
			handlers: [promiseHandler],
			services: Context.make(AsyncConfigFiles, { renameKey }),
		});

		expect(report.status).toBe("completed");
		expect(files.get("app.json")).toEqual({ requestTimeout: 5000 });
	});

	it("runs the manual handler example", async () => {
		const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
		if (Result.isFailure(resolved)) throw resolved.failure;
		const hasKey = (file: string, key: string) => key in (files.get(file) ?? {});
		const asked: Array<string> = [];
		// The person renames the key by hand before answering.
		const ask = async (question: string, _options: { signal: AbortSignal }) => {
			asked.push(question);
			files.set("app.json", { requestTimeout: 5000 });

			return true;
		};
		const manualHandlers = [
			Handler.manual(renameTimeout, {
				verify: ({ file, to }) => hasKey(file, to),
			}),
		];
		const interaction = Interaction.promise(async ({ occurrence }, { signal }) =>
			(await ask(occurrence.action.description, { signal })) ? "confirmed" : "declined",
		);

		files.set("app.json", { timeout: 5000 });
		const report = await Executor.runPromise(resolved.success, {
			handlers: manualHandlers,
			interaction,
		});

		expect(asked).toEqual(['In app.json, rename "timeout" to "requestTimeout"']);
		expect(report.occurrences[0]?.outcome).toEqual({
			_tag: "Completed",
			performer: "manual",
			confirmation: "verified",
		});
		await expect(
			Executor.runPromise(resolved.success, { handlers: manualHandlers }),
		).rejects.toBeInstanceOf(Executor.InteractionUnavailable);
	});

	it("observes a run through the package's observers", async () => {
		files.set("app.json", { timeout: 5000 });
		const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
		if (Result.isFailure(resolved)) throw resolved.failure;
		const plan = resolved.success;
		const lines: Array<string> = [];
		// Stands in for the global console, which the package's ES2022 types leave out.
		const console = { error: (line: string) => void lines.push(line) };

		const logged = widgets.pipe(
			Package.withObserver(Observer.effect((event) => Effect.logDebug(event._tag))),
		);
		const observed = logged.pipe(
			Package.withObserver(
				Observer.sync((event) => {
					if (event._tag !== "ActionSettled") return;
					const { finished, total } = event.progress.actions;
					console.error(
						`[${finished}/${total}] ${event.action.description}: ${event.outcome._tag}`,
					);
				}),
			),
		);
		const report = await Executor.runPromise(plan, { handlers, observers: observed.observers });

		expect(report.observation).toEqual([]);
		expect(lines).toEqual([
			'[1/1] In app.json, rename "timeout" to "requestTimeout": Completed',
		]);
		expect(widgets.observers).toEqual([]);
	});

	it("cancels a round trip with a rule", () => {
		const v3 = Version.make("3.0.0", { previous: v2, changes: [] });
		const toV3 = Migration.make("2.0.0-to-3.0.0", { from: v2, to: v3 })`${restoreTimeout}`;
		const cancelRoundTrip = Rule.replace("cancel-timeout-round-trip", {
			match: [renameTimeout, restoreTimeout],
			replacement: [],
		});
		const withRule = History.make({
			versions: [v1, v2, v3],
			migrations: [reversible, toV3],
			rules: [cancelRoundTrip],
		});
		const resolved = History.resolve(withRule, { from: "1.0.0", to: "3.0.0" });
		if (Result.isFailure(resolved)) throw resolved.failure;

		expect(resolved.success.occurrences).toEqual([]);
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
