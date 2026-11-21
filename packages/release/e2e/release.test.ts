import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { ReleaseFiles } from "@deltafold/release";
import { ReleaseChangelog } from "@deltafold/release/changelog";
import { History, Package, Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";
import {
	diagnostics,
	fixtureText,
	generatedFixtureText,
	workspace,
} from "./__fixtures__/workspace.ts";
import { headers } from "./__fixtures__/workspace/next-pending/headers.ts";
import { timeout } from "./__fixtures__/workspace/pending/timeout.ts";
import { adapter, configure, release, widgets } from "./__fixtures__/workspace/release.ts";

const generatedWidgets = "packages/widgets/versions/2.0.0.ts";
const generatedAdapter = "packages/adapter/versions/2.0.0.ts";
const widgetManifest = "packages/widgets/package.json";
const adapterManifest = "packages/adapter/package.json";

const prepare = Effect.gen(function* () {
	const resolved = yield* ReleaseFiles.resolve(release, {
		packages: [{ package: widgets, changes: [timeout] }, adapter],
	});
	const result = release.plan(resolved.input);
	if (Result.isFailure(result)) throw result.failure;
	return yield* ReleaseFiles.prepare(result.success, {
		pending: ["pending/*.ts"],
		snapshot: resolved.snapshot,
	});
});

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
						generatedAdapter,
						widgetManifest,
						adapterManifest,
						"docs/guide.md",
						"packages/widgets/src/index.ts",
					],
					removed: ["pending/timeout.ts"],
				});
				expect(files.get(generatedWidgets)).toBe(
					generatedFixtureText("widgets-2.0.0.ts.txt"),
				);
				expect(files.get(generatedAdapter)).toBe(
					generatedFixtureText("adapter-2.0.0.ts.txt"),
				);
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
				expect(files.has("pending/timeout.ts")).toBe(false);
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

	it.effect(
		"uses the first release as history and manifest input for a second patch release",
		() => {
			const { files, provide } = workspace();
			return Effect.gen(function* () {
				const first = yield* prepare;
				yield* ReleaseFiles.apply(first);
				const widgetVersion = first.plan.versions.find(
					(entry) => entry.package === widgets.name,
				)?.version;
				const adapterVersion = first.plan.versions.find(
					(entry) => entry.package === adapter.name,
				)?.version;
				if (widgetVersion === undefined || adapterVersion === undefined)
					throw new Error("Missing released version");
				const nextWidgets = Package.make(widgets.name, {
					history: History.make({
						versions: [...widgets.history.versions, widgetVersion],
						migrations: [],
					}),
				});
				const nextAdapter = Package.make(adapter.name, {
					history: History.make({
						versions: [...adapter.history.versions, adapterVersion],
						migrations: [],
					}),
				});
				const nextRelease = configure(nextWidgets, nextAdapter);
				const resolved = yield* ReleaseFiles.resolve(nextRelease, {
					packages: [{ package: nextWidgets, changes: [headers] }, nextAdapter],
				});
				const result = nextRelease.plan(resolved.input);
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
					pending: ["next-pending/*.ts"],
					snapshot: resolved.snapshot,
				});
				const before = new Map(files);
				const report = yield* ReleaseFiles.apply(prepared);
				expect(report).toEqual({
					written: [
						"packages/widgets/versions/2.0.1.ts",
						"packages/adapter/versions/2.0.1.ts",
						widgetManifest,
						adapterManifest,
					],
					removed: ["next-pending/headers.ts"],
				});
				for (const name of ["widgets", "adapter"]) {
					expect(files.get(`packages/${name}/versions/2.0.1.ts`)).toBe(
						generatedFixtureText(`${name}-2.0.1.ts.txt`),
					);
					expect(files.get(`packages/${name}/package.json`)).toBe(
						before.get(`packages/${name}/package.json`)?.replace('"2.0.0"', '"2.0.1"'),
					);
				}
				expect(files.has("next-pending/headers.ts")).toBe(false);
				for (const [path, contents] of before) {
					if (![...report.written, ...report.removed].includes(path))
						expect(files.get(path)).toBe(contents);
				}
				files.set("consumer.ts", fixtureText("second-consumer.ts.txt"));
				expect(diagnostics(files)).toEqual([]);
			}).pipe(provide);
		},
	);

	it.effect(
		"refuses reviewed artifacts after pending inputs and a replacement target change",
		() => {
			const { files, provide } = workspace();
			return Effect.gen(function* () {
				const prepared = yield* prepare;
				files.set("docs/guide.md", "External edit: @next.\n");
				files.set("pending/late.ts", fixtureText("workspace/next-pending/headers.ts"));
				const beforeApply = new Map(files);
				const error = yield* Effect.flip(ReleaseFiles.apply(prepared));
				expect(error).toMatchObject({
					_tag: "StalePlan",
					paths: ["docs/guide.md", "pending/late.ts"],
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
					restored: [generatedAdapter, generatedWidgets],
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
