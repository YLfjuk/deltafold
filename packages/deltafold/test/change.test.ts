import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Result } from "effect";

import { Change, History, Migration, Package, Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";

interface TeamMetadata {
	readonly area: string;
	readonly bump: "major" | "minor" | "patch";
}

const TeamChange = Change.define<TeamMetadata>();

/** Mutual assignability, for unions of changes that expectTypeOf cannot compare. */
type Equals<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;

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

describe("metadata through versions, migrations, and plans", () => {
	const tracked = Change.make("tracked", {
		area: "cli",
		owner: { team: "tools" },
		tickets: [7, 9],
	})`Rename the flag.`;
	const typed = TeamChange.make("typed", { area: "http", bump: "patch" })`Escape headers.`;
	// Distinct metadata keeps TypeScript from merging these change types in unions.
	const restored = Change.make(
		"restored",
		{ area: "cli", restores: "tracked" },
		{ reverts: [tracked], backportOf: typed },
	)`Restore the flag.`;
	const v1 = Version.make("1", { changes: [tracked] });
	const v2 = Version.make("2", { previous: v1, changes: [typed, restored] });
	const migration = Migration.noop("1-to-2", {
		from: v1,
		to: v2,
		addresses: [tracked, typed, restored],
	});
	const history = History.make({ versions: [v1, v2], migrations: [migration] });
	const resolved = History.resolve(history, { from: "1", to: "2" });
	if (Result.isFailure(resolved)) throw resolved.failure;
	const plan = resolved.success;

	it("keeps each change's inferred metadata type", () => {
		expectTypeOf(v1.changes).toEqualTypeOf<ReadonlyArray<typeof tracked>>();
		expectTypeOf(tracked.metadata).toEqualTypeOf<{
			readonly area: "cli";
			readonly owner: { readonly team: "tools" };
			readonly tickets: readonly [7, 9];
		}>();
		type Addressed = typeof tracked | typeof typed | typeof restored;
		expectTypeOf<
			Equals<typeof migration.addresses, ReadonlyArray<Addressed>>
		>().toEqualTypeOf<true>();
		expectTypeOf<Equals<typeof plan.changes, ReadonlyArray<Addressed>>>().toEqualTypeOf<true>();
		expectTypeOf<Equals<History.ChangesOf<typeof history>, Addressed>>().toEqualTypeOf<true>();
		expectTypeOf<
			Equals<typeof v2.changes, ReadonlyArray<typeof typed | typeof restored>>
		>().toEqualTypeOf<true>();
	});

	it("keeps undefined in fields when metadata-free and typed changes mix", () => {
		const plain = Change.make("plain")`Plain.`;
		const area = Change.make("area", { area: "cli" })`Area.`;
		const mixed = Version.make("mixed", { changes: [plain, area] });
		const first = mixed.changes.at(0);

		expect(first?.metadata).toEqual({});
		expectTypeOf(plain.metadata.area).toEqualTypeOf<undefined>();
		expectTypeOf<NonNullable<typeof first>["metadata"]["area"]>().toEqualTypeOf<
			"cli" | undefined
		>();
		if (first !== undefined) {
			// @ts-expect-error the metadata-free change has no `area`.
			first.metadata.area satisfies "cli";
		}
	});

	it("rejects metadata reads that the declared types do not allow", () => {
		expect.assertions(0);
		// @ts-expect-error `area` is a string.
		void (v1.changes.at(0)?.metadata.area satisfies number | undefined);
		// @ts-expect-error the metadata declares no `nonexistent` field.
		void v1.changes.at(0)?.metadata.nonexistent;
		// @ts-expect-error `area` is a string on every addressed change.
		void (plan.changes.at(0)?.metadata.area satisfies number | undefined);
		// @ts-expect-error the ancestor's change type is not known here, so fields need narrowing.
		void v2.previous?.changes.at(0)?.metadata.area;
	});

	it("keeps the change objects, nested metadata, and relationships at run time", () => {
		expect(plan.changes).toEqual([tracked, typed, restored]);
		expect(plan.changes[0]).toBe(tracked);
		expect(plan.changes[0]?.metadata).toEqual({
			area: "cli",
			owner: { team: "tools" },
			tickets: [7, 9],
		});
		expect(plan.changes[2]?.reverts[0]).toBe(tracked);
		expect(plan.changes[2]?.backportOf).toBe(typed);
	});

	it("passes the same metadata to changelog selectors", () => {
		const changelog = Changelog.make<{}>({
			sections: [
				Changelog.section("tools", {
					title: "Tools",
					select: ({ metadata: { owner } }) =>
						typeof owner === "object" &&
						owner !== null &&
						"team" in owner &&
						owner.team === "tools",
				}),
			],
		});
		const pkg = Package.make("@acme/tool", { history });

		expect(Markdown.render(changelog.release(pkg, Version.withMetadata(v1, {})))).toBe(
			"# 1\n\n## Tools\n\n- Rename the flag.\n",
		);
	});
});
