import { describe, expect, expectTypeOf, it } from "@effect/vitest";

import { Change, History, Package, Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";

interface TeamMetadata {
	readonly area: string;
	readonly bump: "major" | "minor" | "patch";
}

const TeamChange = Change.define<TeamMetadata>();

describe("Change", () => {
	it("declares a change without metadata", () => {
		const change = Change.make("2026-11-20.add-retries")`
			Add a retry limit option.
		`;

		expect(change).toEqual({
			_tag: "Change",
			id: "2026-11-20.add-retries",
			metadata: {},
			description: "Add a retry limit option.",
			reverts: [],
			backportOf: undefined,
		});
		expectTypeOf(change.metadata).toEqualTypeOf<Change.NoMetadata>();
	});

	it("infers the metadata of one change, literals included", () => {
		const change = Change.make("2026-11-06.rename-timeout", {
			kind: "changed",
			breaking: true,
			tickets: [101, 102],
		})`Rename the timeout option.`;

		expect(change.metadata).toEqual({ kind: "changed", breaking: true, tickets: [101, 102] });
		expectTypeOf(change.metadata).toEqualTypeOf<{
			readonly kind: "changed";
			readonly breaking: true;
			readonly tickets: readonly [101, 102];
		}>();
	});

	it("enforces one metadata shape through a defined factory", () => {
		const change = TeamChange.make("2026-12-01.fix-header-injection", {
			area: "http",
			bump: "patch",
		})`Escape header values.`;

		expect(change.metadata).toEqual({ area: "http", bump: "patch" });
		expectTypeOf(change).toEqualTypeOf<Change.Change<TeamMetadata>>();

		// @ts-expect-error the factory requires the bump field.
		TeamChange.make("missing-bump", { area: "http" });
		// @ts-expect-error "huge" is not a bump the metadata type allows.
		TeamChange.make("unknown-bump", { area: "http", bump: "huge" });
		// @ts-expect-error a defined factory requires metadata.
		TeamChange.make("no-metadata");
	});

	it("records relationships separately from metadata", () => {
		const renamed = Change.make("rename", { breaking: true })`Rename the option.`;
		const backport = TeamChange.make(
			"rename-1.x",
			{ area: "config", bump: "minor" },
			{ backportOf: renamed },
		)`Accept both option names.`;
		const restored = Change.make("restore", {}, { reverts: [renamed] })`Restore the option.`;

		expect(backport.backportOf).toBe(renamed);
		expect(backport.metadata).toEqual({ area: "config", bump: "minor" });
		expect(restored.reverts).toEqual([renamed]);
		expect(restored.metadata).toEqual({});
	});

	it("lets one release hold changes with different metadata types", () => {
		const plain = Change.make("plain")`Plain change.`;
		const typed = TeamChange.make("typed", { area: "cli", bump: "minor" })`Typed change.`;
		const v1 = Version.make("1.0.0", { changes: [plain, typed] });

		expect(History.validate(History.make({ versions: [v1], migrations: [] }))).toEqual([]);
	});

	it("reports one identifier declared with different metadata", () => {
		const first = TeamChange.make("same", { area: "cli", bump: "minor" })`Same text.`;
		const second = TeamChange.make("same", { area: "cli", bump: "major" })`Same text.`;
		const equal = TeamChange.make("same", { area: "cli", bump: "minor" })`Same text.`;
		const v1 = Version.make("1.0.0", { changes: [first] });
		const v2 = Version.make("2.0.0", { previous: v1, changes: [second] });
		const v3 = Version.make("3.0.0", { previous: v1, changes: [equal] });

		expect(
			History.validate(History.make({ versions: [v1, v2], migrations: [] })).map(
				(issue) => issue._tag,
			),
		).toEqual(["ConflictingChange"]);
		expect(History.validate(History.make({ versions: [v1, v3], migrations: [] }))).toEqual([]);
	});
});

describe("changelog sections and change metadata", () => {
	const breaking = Change.make("breaking", { kind: "removed", breaking: true })`Remove a flag.`;
	const fixed = Change.make("fixed", { kind: "fixed" })`Fix a crash.`;
	const v1 = Version.make("1.0.0", { changes: [breaking, fixed] });
	const pkg = Package.make("@acme/tool", {
		history: History.make({ versions: [v1], migrations: [] }),
	});
	const release = Version.withMetadata(v1, {});

	it("lists every change under one section without classifying by metadata", () => {
		expect(Markdown.render(Changelog.make<{}>().release(pkg, release))).toBe(
			"# 1.0.0\n\n## Changes\n\n- Remove a flag.\n- Fix a crash.\n",
		);
	});

	it("selects changes by the metadata the consumer declares", () => {
		const changelog = Changelog.make<{}>({
			sections: [
				Changelog.section("breaking", {
					title: "Breaking changes",
					select: (change) => change.metadata.breaking === true,
				}),
			],
		});

		expect(Markdown.render(changelog.release(pkg, release))).toBe(
			"# 1.0.0\n\n## Breaking changes\n\n- Remove a flag.\n\n## Other changes\n\n- Fix a crash.\n",
		);
	});
});
