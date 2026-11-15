import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { Release, ReleaseFiles, ReleaseSource, VersionStrategy } from "@deltafold/release";
import { memoryFs } from "./__fixtures__/memory-fs.ts";
import { packageWith, ProjectChange, retries } from "./__fixtures__/packages.ts";

describe("path arithmetic", () => {
	it("keeps absolute POSIX and Windows drive prefixes", () => {
		expect(ReleaseSource.join("/repo/packages", "../tools", "x.ts")).toBe("/repo/tools/x.ts");
		expect(ReleaseSource.join("/repo", "../../..")).toBe("/");
		expect(ReleaseSource.join("c:\\repo\\packages", "..\\docs")).toBe("C:/repo/docs");
		expect(ReleaseSource.dirname("/repo/a.ts")).toBe("/repo");
		expect(ReleaseSource.dirname("D:/a.ts")).toBe("D:/");
		expect(ReleaseSource.join("packages", "/abs/x.ts")).toBe("/abs/x.ts");
		expect(ReleaseSource.join("../outside", "x")).toBe("../outside/x");
		expect(ReleaseSource.relative("/repo/packages/a/versions", "/repo/src/changes.ts")).toBe(
			"../../../src/changes.ts",
		);
	});
});

describe("ReleaseFiles.at", () => {
	it("joins the manifest and defaults versions to .deltafold/versions", () => {
		expect(ReleaseFiles.at("packages/widgets", { manifest: "package.json" })).toEqual({
			manifest: "packages/widgets/package.json",
			versions: "packages/widgets/.deltafold/versions",
		});
		expect(
			ReleaseFiles.at("packages/widgets", { manifest: "deno.json", versions: "history" }),
		).toEqual({ manifest: "packages/widgets/deno.json", versions: "packages/widgets/history" });
		// @ts-expect-error the manifest is required; deltafold assumes no manifest name.
		const missing: Parameters<typeof ReleaseFiles.at>[1] = {};
		expect(missing).toEqual({});
	});
});

describe("locations", () => {
	const widgets = packageWith("@acme/widgets", ["1.5.2"]);
	const configured = (manifest: string) =>
		Release.make("widgets", {
			packages: [
				{
					package: widgets,
					files: { manifest, versions: "../packages/widgets/.deltafold/versions" },
				},
			],
			change: ProjectChange,
			version: VersionStrategy.semver({ bump: (change) => change.metadata.bump }),
		});
	const planFor = (manifest: string) => {
		const result = configured(manifest).plan({
			packages: [{ package: widgets, previous: "1.5.2", changes: [retries] }],
		});
		if (Result.isFailure(result)) throw new Error(result.failure.message);

		return result.success;
	};
	const files = {
		"/ws/packages/widgets/package.json": `{\n\t"name": "@acme/widgets",\n\t"version": "1.5.2"\n}\n`,
		"/ws/packages/widgets/.deltafold/versions/1.5.2.ts": "export const version = undefined;\n",
		"/ws/release/changes/retries.ts": `import { ProjectChange } from "../../src/changes.ts";\n\nexport const retries = ProjectChange.make("add-retries", { bump: "minor", area: "api" })\`Add a retry limit option.\`;\n`,
	};

	it.effect(
		"resolves relative paths against the config directory and reports workspace paths",
		() => {
			const { files: written, provide } = memoryFs(files);

			return Effect.gen(function* () {
				const prepared = yield* ReleaseFiles.prepare(
					planFor("../packages/widgets/package.json"),
					{
						root: "/ws",
						base: "release",
						pending: ["changes/*.ts"],
					},
				);
				expect(prepared.edits.map((edit) => edit.path)).toEqual([
					"packages/widgets/.deltafold/versions/1.6.0.ts",
					"packages/widgets/package.json",
					"release/changes/retries.ts",
				]);
				yield* ReleaseFiles.apply(prepared);
				expect(written.get("/ws/packages/widgets/.deltafold/versions/1.6.0.ts")).toContain(
					`import { ProjectChange } from "../../../../src/changes.ts";`,
				);
				expect(written.get("/ws/packages/widgets/package.json")).toContain(
					`"version": "1.6.0"`,
				);
			}).pipe(provide);
		},
	);

	it.effect("accepts absolute paths inside the workspace and refuses those outside", () => {
		const { provide } = memoryFs(files);

		return Effect.gen(function* () {
			const inside = yield* ReleaseFiles.prepare(
				planFor("/ws/packages/widgets/package.json"),
				{
					root: "/ws",
					base: "release",
					pending: ["/ws/release/changes/*.ts"],
				},
			);
			expect(inside.edits.map((edit) => edit.path)).toContain(
				"packages/widgets/package.json",
			);

			const outside = yield* Effect.flip(
				ReleaseFiles.prepare(planFor("/elsewhere/package.json"), {
					root: "/ws",
					base: "release",
					pending: ["changes/*.ts", "../../escape/*.ts"],
				}),
			);
			expect(
				outside._tag === "PrepareError" &&
					outside.issues.map((entry) => [entry.reason, entry.subjects]),
			).toEqual([
				["OutsideWorkspace", ["../../escape/*.ts"]],
				["OutsideWorkspace", ["/elsewhere/package.json"]],
			]);
		}).pipe(provide);
	});
});
