import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { Change, History, Migration, Package, Rule, Version } from "deltafold";
import { Changelog, Document } from "deltafold/changelog";
import * as Html from "deltafold/html";
import * as Markdown from "deltafold/markdown";
import {
	addRetryLimit,
	renameTimeout,
	restoreTimeout,
	retriesAdded,
	securityFixed,
	timeoutRenamed,
	timeoutRestored,
} from "./__fixtures__/config.ts";

type ReleaseMetadata = {
	readonly releasedAt: string;
	readonly commit: string;
	readonly contributors?: ReadonlyArray<{ readonly name: string; readonly url?: string }>;
};

const v0 = Version.make("0.0.0", { changes: [] });
const v100 = Version.make("1.0.0", { previous: v0, changes: [timeoutRenamed, retriesAdded] });
const v200 = Version.make("2.0.0", { previous: v100, changes: [timeoutRestored, securityFixed] });
const v101 = Version.make("1.0.1", { previous: v100, changes: [securityFixed] });

const configure = Migration.make("1.0.0-to-2.0.0", {
	from: v100,
	to: v200,
	addresses: [timeoutRestored],
})`
	Shared context for version 2.

	${Migration.instruction(addRetryLimit)`Add a retry limit. Start with ${3}.`}

	${Migration.instruction(restoreTimeout)`Restore the timeout option.`}
`;
const initial = Migration.make("0.0.0-to-1.0.0", {
	from: v0,
	to: v100,
	addresses: [timeoutRenamed, retriesAdded],
})`${Migration.instruction(renameTimeout)`Rename the timeout option.`}`;
const patch = Migration.noop("1.0.0-to-1.0.1", {
	from: v100,
	to: v101,
	addresses: [securityFixed],
});

const history = History.make({
	versions: [v0, v100, v200, v101],
	migrations: [initial, configure, patch],
});
const widgets = Package.make("@acme/widgets", { history });

const release0 = Version.withMetadata(v0, { releasedAt: "2026-01-01", commit: "aaa111" });
const release100 = Version.withMetadata(v100, {
	releasedAt: "2026-06-01",
	commit: "bbb222",
	contributors: [{ name: "Alice", url: "https://example.com/alice" }, { name: "Bob" }],
});
const release101 = Version.withMetadata(v101, { releasedAt: "2026-07-01", commit: "ccc333" });
const release200 = Version.withMetadata(v200, { releasedAt: "2026-11-06", commit: "ddd444" });
const releases = [release100, release0, release200, release101];

const calls: Array<string> = [];

const contributorsPlugin = Document.Plugin.make<ReleaseMetadata>("contributors", {
	scope: Document.Release,
	at: Document.Body.post,
	resolve: ({ version, metadata }) => {
		calls.push(`contributors:${version.id}`);
		if (!metadata.contributors?.length) return null;

		return Document.Section("contributors", {
			title: Document.Title("Contributors"),
			children: [
				Document.List(
					metadata.contributors.map((person) =>
						person.url === undefined
							? Document.Text(person.name)
							: Document.Link(person.name, person.url),
					),
				),
			],
		});
	},
});

const commitPlugin = Document.Plugin.make<ReleaseMetadata>("commit", {
	scope: Document.Release,
	at: Document.Title.post,
	resolve: ({ metadata }) =>
		Document.Paragraph([
			"Released ",
			metadata.releasedAt,
			" from ",
			Document.Code(metadata.commit),
		]),
});

const summaryPlugin = Document.Plugin.make<ReleaseMetadata>("summary", {
	scope: Document.History,
	at: Document.Body.pre,
	resolve: ({ releases: included }) => {
		calls.push("summary");

		return Document.Paragraph(`${included.length} releases.`);
	},
});

const changelog = Changelog.make<ReleaseMetadata>({
	sections: [
		Changelog.section("breaking", {
			title: "Breaking changes",
			select: (change) => change.breaking,
		}),
		Changelog.section("features", {
			title: "Features",
			select: (change) => change.kind === "added",
		}),
		Changelog.section("fixes", { title: "Fixes", select: (change) => change.kind === "fixed" }),
	],
	plugins: [commitPlugin, contributorsPlugin, summaryPlugin],
});

const cancel = Rule.replace("cancel-timeout-round-trip", {
	match: [renameTimeout, addRetryLimit],
	replacement: [],
});

const planFor = (rules: ReadonlyArray<Rule.Any>) => {
	const resolved = History.resolve(
		History.make({ versions: [v0, v100, v200], migrations: [initial, configure], rules }),
		{ from: "0.0.0", to: "2.0.0" },
	);
	if (Result.isFailure(resolved)) throw resolved.failure;

	return resolved.success;
};

const leveled = (level: number): Document.Document => ({
	_tag: "Document",
	kind: "release",
	children: [
		Document.Section("root", {
			title: "Root",
			children: [Document.Section("deep", { title: Document.Title("Deep", { level }) })],
		}),
	],
});

describe("scenario 12: drafts and annotated releases", () => {
	it("renders a change that is not released yet", () => {
		expect(Markdown.render(changelog.change(retriesAdded))).toBe(
			"# Unreleased\n\n## Features\n\n- Add a retry limit option.\n",
		);
	});

	it("renders an annotated release with plugins at their anchors", () => {
		calls.length = 0;

		expect(Markdown.render(changelog.release(widgets, release100))).toBe(
			[
				"# 1.0.0",
				"",
				"Released 2026-06-01 from `bbb222`",
				"",
				"## Breaking changes",
				"",
				"- Rename the timeout configuration option to requestTimeout.",
				"",
				"## Features",
				"",
				"- Add a retry limit option.",
				"",
				"## Contributors",
				"",
				"- [Alice](https://example.com/alice)",
				"- Bob",
				"",
			].join("\n"),
		);
		expect(calls).toEqual(["contributors:1.0.0"]);
	});

	it("does not need metadata in history or names in metadata", () => {
		expect(v100).toEqual({
			_tag: "Version",
			id: "1.0.0",
			previous: v0,
			changes: [timeoutRenamed, retriesAdded],
		});
		expect(release100.version).toBe(v100);
		expect(widgets).toEqual({ _tag: "Package", name: "@acme/widgets", history });
	});
});

describe("scenarios 13 and 15: release history", () => {
	it("titles the history with the package name and keeps reverted changes", () => {
		calls.length = 0;
		const markdown = Markdown.render(changelog.history(widgets, { releases }));

		expect(markdown.split("\n").filter((line) => line.startsWith("#"))).toEqual([
			"# @acme/widgets",
			"## 2.0.0",
			"### Breaking changes",
			"### Fixes",
			"## 1.0.1",
			"### Fixes",
			"## 1.0.0",
			"### Breaking changes",
			"### Features",
			"### Contributors",
			"## 0.0.0",
		]);
		expect(markdown).toContain("- Rename the timeout configuration option to requestTimeout.");
		expect(markdown).toContain("- Restore the timeout configuration option.");
		expect(markdown).toContain("4 releases.");
		expect(calls).toEqual([
			"contributors:2.0.0",
			"contributors:1.0.1",
			"contributors:1.0.0",
			"contributors:0.0.0",
			"summary",
		]);
	});

	it("reports missing, duplicate, and unrelated release metadata", () => {
		const unrelated = Version.withMetadata(
			Version.make("9.9.9", { changes: [] }),
			release0.metadata,
		);

		expect(() => changelog.history(widgets, { releases: [release100] })).toThrow(
			'Release metadata is missing for "0.0.0", "2.0.0", "1.0.1".',
		);
		expect(() => changelog.history(widgets, { releases: [...releases, release100] })).toThrow(
			'Release metadata is supplied more than once for "1.0.0".',
		);
		expect(() => changelog.history(widgets, { releases: [...releases, unrelated] })).toThrow(
			'Release metadata for "9.9.9" does not belong to the history of "@acme/widgets".',
		);
		expect(() => changelog.release(widgets, unrelated)).toThrow("does not belong");
	});

	it("limits a history to selected versions", () => {
		const markdown = Markdown.render(
			changelog.history(widgets, {
				releases: [release100, release101],
				versions: [v100, v101],
			}),
		);

		expect(markdown.split("\n").filter((line) => line.startsWith("## "))).toEqual([
			"## 1.0.1",
			"## 1.0.0",
		]);
	});

	it("takes no package name in the changelog configuration", () => {
		// @ts-expect-error package identity comes from Package.make.
		Changelog.make({ name: "@acme/widgets" });

		expect(changelog).not.toHaveProperty("name");
	});
});

describe("scenario 13: resolved guides", () => {
	it("renders every instruction when nothing is optimized", () => {
		expect(Markdown.render(changelog.upgrade(planFor([]), { package: widgets }))).toBe(
			[
				"# Upgrade @acme/widgets from 0.0.0 to 2.0.0",
				"",
				"## 0.0.0 to 1.0.0",
				"",
				"Rename the timeout option.",
				"",
				"## 1.0.0 to 2.0.0",
				"",
				"Shared context for version 2.",
				"",
				"Add a retry limit. Start with 3.",
				"",
				"Restore the timeout option.",
				"",
			].join("\n"),
		);
	});

	it("omits cancelled instructions while the history keeps their changes", () => {
		const optimized = planFor([cancel]);
		const markdown = Markdown.render(changelog.upgrade(optimized, { explain: true }));

		expect(markdown).toBe(
			[
				"# Upgrade from 0.0.0 to 2.0.0",
				"",
				"## 1.0.0 to 2.0.0",
				"",
				"Shared context for version 2.",
				"",
				"Restore the timeout option.",
				"",
				"## Omitted instructions",
				"",
				'- Rule "cancel-timeout-round-trip" cancelled: In config, rename "timeout" to "requestTimeout"; In config, add "retries".',
				'- Rules removed every action of migration "0.0.0-to-1.0.0".',
				"",
			].join("\n"),
		);
		expect(Markdown.render(changelog.history(widgets, { releases }))).toContain(
			"Rename the timeout configuration option to requestTimeout.",
		);
	});

	it("renders an empty plan as a valid guide", () => {
		const resolved = History.resolve(history, { from: "1.0.0", to: "1.0.1" });
		if (Result.isFailure(resolved)) throw resolved.failure;

		expect(Markdown.render(changelog.upgrade(resolved.success))).toBe(
			"# Upgrade from 1.0.0 to 1.0.1\n\nNo migration work is needed.\n",
		);
	});
});

describe("scenario 14: document structure and escaping", () => {
	it("builds nodes with constructors and pipeable transformations", () => {
		const title = Document.Title("Contributors").pipe(Document.withLevel(3));
		const section = Document.Section("contributors").pipe(
			Document.withTitle("Contributors"),
			Document.append(Document.List([Document.Text("Alice")])),
		);

		expect(title.level).toBe(3);
		expect(Document.Title("Contributors", { level: 3 }).level).toBe(3);
		expect(
			Markdown.render({
				_tag: "Document",
				kind: "release",
				children: [Document.Section("root", { title: "Root", children: [section] })],
			}),
		).toBe("# Root\n\n## Contributors\n\n- Alice\n");
	});

	it("treats explicit levels as absolute and rejects unsupported ones", () => {
		expect(Markdown.render(leveled(4))).toBe("# Root\n\n#### Deep\n");
		expect(() => Markdown.render(leveled(7))).toThrow("levels range from 1 to 6");
	});

	it("scopes section identifiers to their release", () => {
		const duplicate = Document.Plugin.make<ReleaseMetadata>("duplicate", {
			scope: Document.Release,
			at: Document.Body.post,
			resolve: () => Document.Section("fixed", { title: "More fixes" }),
		});
		const strict = Changelog.make<ReleaseMetadata>({ plugins: [duplicate] });

		expect(() => Markdown.render(strict.release(widgets, release101))).toThrow(
			'Section "fixed" appears more than once in release "1.0.1".',
		);
		const lenient = Changelog.make<ReleaseMetadata>({
			sections: [
				Changelog.section("fixes", {
					title: "Fixes",
					select: (change) => change.kind === "fixed",
				}),
			],
		});
		expect(() => Markdown.render(lenient.history(widgets, { releases }))).not.toThrow();
	});

	it("escapes content in Markdown and HTML", () => {
		const tricky = Change.make("tricky", {
			kind: "fixed",
		})`Use *literal* <b>tags</b> & [brackets]`;
		const document = changelog.change(tricky);

		expect(Markdown.render(document)).toBe(
			"# Unreleased\n\n## Fixes\n\n- Use \\*literal\\* \\<b>tags\\</b> & \\[brackets]\n",
		);
		expect(Html.render(document)).toBe(
			"<h1>Unreleased</h1>\n<h2>Fixes</h2>\n<ul>\n<li>Use *literal* &#x3C;b>tags&#x3C;/b> &#x26; [brackets]</li>\n</ul>",
		);
	});

	it("renders nested sections, lists, and links in HTML", () => {
		expect(Html.render(changelog.release(widgets, release100))).toBe(
			[
				"<h1>1.0.0</h1>",
				"<p>Released 2026-06-01 from <code>bbb222</code></p>",
				"<h2>Breaking changes</h2>",
				"<ul>",
				"<li>Rename the timeout configuration option to requestTimeout.</li>",
				"</ul>",
				"<h2>Features</h2>",
				"<ul>",
				"<li>Add a retry limit option.</li>",
				"</ul>",
				"<h2>Contributors</h2>",
				"<ul>",
				'<li><a href="https://example.com/alice">Alice</a></li>',
				"<li>Bob</li>",
				"</ul>",
			].join("\n"),
		);
	});
});
