import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { ReleaseFiles } from "@deltafold/release";
import { ReleaseChangelog } from "@deltafold/release/changelog";
import { History, Package, Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";
import { loadPackage } from "./__fixtures__/load-package.ts";
import {
	diagnostics,
	fixtureText,
	generatedFixtureText,
	workspace,
} from "./__fixtures__/workspace.ts";
import { release } from "./__fixtures__/workspace/deltafold.config.ts";
import { adapter } from "./__fixtures__/workspace/packages/adapter/.deltafold/package.ts";
import { timeout } from "./__fixtures__/workspace/packages/widgets/.deltafold/changes/timeout.ts";
import { widgets } from "./__fixtures__/workspace/packages/widgets/.deltafold/package.ts";
import { headers } from "./__fixtures__/workspace/packages/widgets/.deltafold/queued/headers.ts";

const pending = "packages/*/.deltafold/changes/*.ts";
const pendingTimeout = "packages/widgets/.deltafold/changes/timeout.ts";
const pendingHeaders = "packages/widgets/.deltafold/changes/headers.ts";
const queuedHeaders = "workspace/packages/widgets/.deltafold/queued/headers.ts";
const generatedWidgets = "packages/widgets/.deltafold/versions/2.0.0.ts";
const generatedAdapter = "packages/adapter/.deltafold/versions/2.0.0.ts";
const widgetsIndex = "packages/widgets/.deltafold/versions/index.ts";
const adapterIndex = "packages/adapter/.deltafold/versions/index.ts";
const adapterHistory = "packages/adapter/.deltafold/package.ts";
const widgetManifest = "packages/widgets/package.json";
const adapterManifest = "packages/adapter/package.json";

const prepareFirst = (input?: Parameters<typeof release.plan>[0]["input"]) =>
	Effect.gen(function* () {
		const resolved = yield* ReleaseFiles.resolve(release, {
			packages: [{ package: widgets, changes: [timeout] }, adapter],
			input,
		});
		const result = release.plan(resolved.input);
		if (Result.isFailure(result)) throw result.failure;
		return yield* ReleaseFiles.prepare(result.success, {
			pending: [pending],
			snapshot: resolved.snapshot,
		});
	});

const prepare = prepareFirst();

const updateAdapterHistory = (files: Map<string, string>, version: string) =>
	files.set(
		adapterHistory,
		fixtureText("adapter-history.ts.txt").replace("{{previousVersion}}", version),
	);

describe("fixture workspace consumer", () => {
	it.effect(
		"releases a breaking change with shared-group alignment and a peer range update",
		() => {
			const { files, provide } = workspace();
			const before = new Map(files);
			return Effect.gen(function* () {
				const prepared = yield* prepare;
				expect(files).toEqual(before);
				expect(
					prepared.plan.versions.map((entry) => [
						entry.package,
						entry.version.id,
						entry.reason,
					]),
				).toEqual([
					["@fixture/widgets", "2.0.0", "changes"],
					["@fixture/adapter", "2.0.0", "alignment"],
				]);
				expect(prepared.plan.dependencyUpdates).toEqual([
					{
						dependent: "@fixture/adapter",
						dependency: "@fixture/widgets",
						field: "peerDependencies",
						manifest: adapterManifest,
						from: "^1.2.0",
						to: "^2.0.0",
						version: "2.0.0",
					},
				]);
				expect(prepared.replacements).toEqual([
					{
						match: "@next",
						versionOf: "@fixture/widgets",
						version: "2.0.0",
						files: [
							{ path: "docs/guide.md", occurrences: 1 },
							{ path: "packages/widgets/src/index.ts", occurrences: 1 },
						],
						zeroMatches: false,
					},
				]);
				const report = yield* ReleaseFiles.apply(prepared);
				expect(report).toEqual({
					written: [
						generatedWidgets,
						widgetsIndex,
						generatedAdapter,
						widgetManifest,
						adapterManifest,
						"docs/guide.md",
						"packages/widgets/src/index.ts",
					],
					removed: [pendingTimeout],
				});
				expect(files.get(generatedWidgets)).toBe(
					generatedFixtureText("widgets-2.0.0.ts.txt"),
				);
				expect(files.get(generatedAdapter)).toBe(
					generatedFixtureText("adapter-2.0.0.ts.txt"),
				);
				expect(files.get(widgetsIndex)).toBe(
					generatedFixtureText("widgets-index-first.ts.txt"),
				);
				expect(files.has(adapterIndex)).toBe(false);
				expect(files.get(widgetManifest)).toBe(
					before.get(widgetManifest)?.replace("1.2.0", "2.0.0"),
				);
				expect(files.get(adapterManifest)).toBe(
					before.get(adapterManifest)?.replaceAll("1.2.0", "2.0.0"),
				);
				expect(files.get("docs/guide.md")).toBe(
					"The requestTimeout option is available since 2.0.0.\n",
				);
				expect(files.get("packages/widgets/src/index.ts")).toBe(
					"/** @since 2.0.0 */\nexport const requestTimeout = 30;\n",
				);
				expect(files.has(pendingTimeout)).toBe(false);
				for (const [path, contents] of before) {
					if (![...report.written, ...report.removed].includes(path))
						expect(files.get(path)).toBe(contents);
				}

				files.set("consumer.ts", fixtureText("consumer.ts.txt"));
				expect(diagnostics(files)).toEqual([]);
				// Prove the compiler actually resolves generated imports rather than accepting a missing module.
				const broken = new Map(files);
				broken.delete(generatedWidgets);
				expect(
					diagnostics(broken).some((message) => message.includes("Cannot find module")),
				).toBe(true);

				const changelog = Changelog.make<ReleaseChangelog.DependencyMetadata>({
					sections: ReleaseChangelog.bySignificance,
					plugins: [ReleaseChangelog.dependencies({ verbose: true })],
				});
				const rendered = prepared.plan.versions.map((entry) => {
					const pkg = entry.package === widgets.name ? widgets : adapter;
					const released = Package.make(pkg.name, {
						history: History.make({
							versions: [...pkg.history.versions, entry.version],
							migrations: [],
						}),
					});
					return Markdown.render(
						changelog.history(released, {
							versions: [entry.version],
							releases: [
								Version.withMetadata(entry.version, {
									dependencies: entry.dependencies,
								}),
							],
						}),
					);
				});
				expect(rendered[0]).toContain("### Major Changes");
				expect(rendered[0]).toContain(
					"Rename timeout to requestTimeout. See https://example.com/widgets/timeouts.",
				);
				expect(rendered[1]).toContain(
					"### Updated Dependencies\n\n- `@fixture/widgets@2.0.0` (peerDependencies: ^1.2.0 to ^2.0.0)",
				);
			}).pipe(provide);
		},
	);

	it.effect("reloads indexed history and requires an explicit update for manual history", () => {
		const { files, provide } = workspace();
		return Effect.gen(function* () {
			const first = yield* prepare;
			yield* ReleaseFiles.apply(first);
			files.set(pendingHeaders, fixtureText(queuedHeaders));
			const nextWidgets = loadPackage(files, "widgets");
			const staleAdapter = loadPackage(files, "adapter");
			expect(nextWidgets.history.versions.map((version) => version.id)).toEqual([
				"1.2.0",
				"2.0.0",
			]);
			expect(staleAdapter.history.versions.map((version) => version.id)).toEqual(["1.2.0"]);
			expect(files.has(adapterIndex)).toBe(false);
			const stale = yield* ReleaseFiles.resolve(release, {
				packages: [{ package: nextWidgets, changes: [headers] }, staleAdapter],
			});
			const refused = release.plan(stale.input);
			if (Result.isSuccess(refused)) throw new Error("Expected stale manual history to fail");
			expect(refused.failure).toMatchObject({
				reason: "UnknownPrevious",
				subjects: [adapter.name, "2.0.0"],
			});

			updateAdapterHistory(files, "2.0.0");
			const nextAdapter = loadPackage(files, "adapter");
			const resolved = yield* ReleaseFiles.resolve(release, {
				packages: [{ package: nextWidgets, changes: [headers] }, nextAdapter],
			});
			const result = release.plan(resolved.input);
			if (Result.isFailure(result)) throw result.failure;
			expect(
				result.success.versions.map((entry) => [
					entry.package,
					entry.version.id,
					entry.version.previous?.id,
				]),
			).toEqual([
				[widgets.name, "2.0.1", "2.0.0"],
				[adapter.name, "2.0.1", "2.0.0"],
			]);
			expect(result.success.dependencyUpdates).toEqual([]);
			const prepared = yield* ReleaseFiles.prepare(result.success, {
				pending: [pending],
				snapshot: resolved.snapshot,
			});
			const before = new Map(files);
			const report = yield* ReleaseFiles.apply(prepared);
			expect(report).toEqual({
				written: [
					"packages/widgets/.deltafold/versions/2.0.1.ts",
					widgetsIndex,
					"packages/adapter/.deltafold/versions/2.0.1.ts",
					widgetManifest,
					adapterManifest,
				],
				removed: [pendingHeaders],
			});
			for (const name of ["widgets", "adapter"]) {
				expect(files.get(`packages/${name}/.deltafold/versions/2.0.1.ts`)).toBe(
					generatedFixtureText(`${name}-2.0.1.ts.txt`),
				);
				expect(files.get(`packages/${name}/package.json`)).toBe(
					before.get(`packages/${name}/package.json`)?.replace('"2.0.0"', '"2.0.1"'),
				);
			}
			expect(files.has(pendingHeaders)).toBe(false);
			expect(files.get(widgetsIndex)).toBe(
				generatedFixtureText("widgets-index-second.ts.txt"),
			);
			expect(files.has(adapterIndex)).toBe(false);
			expect(
				loadPackage(files, "widgets").history.versions.map((version) => version.id),
			).toEqual(["1.2.0", "2.0.0", "2.0.1"]);
			for (const [path, contents] of before) {
				if (![...report.written, ...report.removed].includes(path))
					expect(files.get(path)).toBe(contents);
			}
			files.set("consumer.ts", fixtureText("second-consumer.ts.txt"));
			expect(diagnostics(files)).toEqual([]);
		}).pipe(provide);
	});

	it.effect("starts and continues a prerelease from the applied history", () => {
		const { files, provide } = workspace();
		return Effect.gen(function* () {
			const first = yield* prepareFirst({ pre: { tag: "beta", continue: false } });
			expect(
				first.plan.versions.map((entry) => [
					entry.package,
					entry.version.id,
					entry.version.previous?.id,
				]),
			).toEqual([
				[widgets.name, "2.0.0-beta.0", "1.2.0"],
				[adapter.name, "2.0.0-beta.0", "1.2.0"],
			]);
			yield* ReleaseFiles.apply(first);
			for (const path of [widgetManifest, adapterManifest]) {
				expect(files.get(path)).toContain('"version": "2.0.0-beta.0"');
			}
			expect(files.has(adapterIndex)).toBe(false);

			files.set(pendingHeaders, fixtureText(queuedHeaders));
			updateAdapterHistory(files, "2.0.0-beta.0");
			const resolved = yield* ReleaseFiles.resolve(release, {
				packages: [
					{ package: loadPackage(files, "widgets"), changes: [headers] },
					loadPackage(files, "adapter"),
				],
				input: { pre: { tag: "beta", continue: true } },
			});
			const continued = release.plan(resolved.input);
			if (Result.isFailure(continued)) throw continued.failure;
			expect(
				continued.success.versions.map((entry) => [
					entry.package,
					entry.version.id,
					entry.version.previous?.id,
				]),
			).toEqual([
				[widgets.name, "2.0.0-beta.1", "2.0.0-beta.0"],
				[adapter.name, "2.0.0-beta.1", "2.0.0-beta.0"],
			]);
			const prepared = yield* ReleaseFiles.prepare(continued.success, {
				pending: [pending],
				snapshot: resolved.snapshot,
			});
			expect((yield* ReleaseFiles.apply(prepared)).removed).toEqual([pendingHeaders]);
			expect(files.has(adapterIndex)).toBe(false);
			expect(
				loadPackage(files, "widgets").history.versions.map((version) => [
					version.id,
					version.previous?.id,
				]),
			).toEqual([
				["1.2.0", undefined],
				["2.0.0-beta.0", "1.2.0"],
				["2.0.0-beta.1", "2.0.0-beta.0"],
			]);
			for (const path of [widgetManifest, adapterManifest]) {
				expect(files.get(path)).toContain('"version": "2.0.0-beta.1"');
			}
			expect(diagnostics(files)).toEqual([]);
		}).pipe(provide);
	});

	it.effect(
		"refuses reviewed artifacts after pending inputs and a replacement target change",
		() => {
			const { files, provide } = workspace();
			return Effect.gen(function* () {
				const prepared = yield* prepare;
				files.set("docs/guide.md", "External edit: @next.\n");
				files.set(pendingHeaders, fixtureText(queuedHeaders));
				files.set(widgetsIndex, "// External index edit.\n");
				const beforeApply = new Map(files);
				const error = yield* Effect.flip(ReleaseFiles.apply(prepared));
				expect(error).toMatchObject({
					_tag: "StalePlan",
					paths: ["docs/guide.md", pendingHeaders, widgetsIndex],
				});
				expect(files).toEqual(beforeApply);
			}).pipe(provide);
		},
	);

	it.effect(
		"recovers owned writes after a deterministic failure and preserves another writer's contents",
		() => {
			const { files, provide } = workspace({
				failWriteOnce: adapterManifest,
				beforeWrite: (path, current) => {
					if (path !== adapterManifest) return;
					current.set(widgetManifest, '"external manifest edit"\n');
					current.set("unrelated.txt", "External unrelated edit.\n");
				},
			});
			return Effect.gen(function* () {
				const before = new Map(files);
				const prepared = yield* prepare;
				const error = yield* Effect.flip(ReleaseFiles.apply(prepared));
				expect(error).toMatchObject({
					_tag: "ApplyFailed",
					path: adapterManifest,
					restored: [generatedAdapter, widgetsIndex, generatedWidgets],
					unrestored: [{ path: widgetManifest, cause: { _tag: "ChangedDuringApply" } }],
				});
				expect(files.get(widgetManifest)).toBe('"external manifest edit"\n');
				expect(files.get("unrelated.txt")).toBe("External unrelated edit.\n");
				for (const [path, contents] of before) {
					if (![widgetManifest, "unrelated.txt"].includes(path))
						expect(files.get(path)).toBe(contents);
				}
				expect(files.has(generatedWidgets)).toBe(false);
				expect(files.has(generatedAdapter)).toBe(false);
			}).pipe(provide);
		},
	);
});
