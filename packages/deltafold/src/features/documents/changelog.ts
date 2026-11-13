import { Array as Arr, Data, Order, Result, SemVer } from "effect";

import type * as Action from "../../foundation/action.ts";
import * as Change from "../../foundation/change.ts";
import type { Prose } from "../../foundation/instruction.ts";
import type { Coverage, GuideItem, Plan, Step } from "../../foundation/plan.ts";
import type { Release, Version } from "../../foundation/version.ts";
import type { Package } from "../package.ts";
import * as Document from "./document.ts";
import { asRelease, blocksOf, insertAll } from "./sections.ts";

/**
 * A change section of a release. The first section whose `select` matches wins. Selectors
 * read the metadata that the consumer declared on each change.
 *
 * @since @next
 */
export type SectionDefinition = {
	readonly _tag: "ChangelogSection";
	readonly id: string;
	readonly title: string;
	readonly select: (change: Change.Change) => boolean;
};

/** @since @next */
export const section = (
	id: string,
	options: { readonly title: string; readonly select: (change: Change.Change) => boolean },
): SectionDefinition => ({ _tag: "ChangelogSection", id, ...options });

/**
 * Release metadata does not match the package history.
 *
 * @since @next
 */
export class ReleaseMetadataError extends Data.TaggedError("ReleaseMetadataError")<{
	readonly reason: "duplicate" | "unrelated" | "missing";
	readonly versions: ReadonlyArray<string>;
	readonly message: string;
}> {}

/** @since @next */
export type HistoryOptions<M> = {
	/** Release metadata annotations, one per included version, in any order. */
	readonly releases: ReadonlyArray<Release<M>>;
	/** The versions to include. Defaults to every version in the package history. */
	readonly versions?: ReadonlyArray<Version>;
};

/** @since @next */
export type GuideOptions = {
	/** The modeled package, for the guide title. */
	readonly package?: Package;
	/** Adds a section that lists omitted instructions and the rules responsible. */
	readonly explain?: boolean;
};

/** @since @next */
export type Changelog<M> = {
	readonly sections: ReadonlyArray<SectionDefinition>;
	readonly plugins: ReadonlyArray<Document.Plugin<M>>;
	/** A document for changes that are not assigned to a release yet. */
	readonly change: (
		change: Change.Any | ReadonlyArray<Change.Any>,
		options?: { readonly title?: string },
	) => Document.Document;
	/** The section for one release. */
	readonly release: (pkg: Package, release: Release<M>) => Document.Document;
	/**
	 * Release history, titled with the package name. Historical changes stay, including
	 * reverted ones. Releases are listed newest first by semver when every identifier
	 * parses, and in reverse registration order otherwise.
	 */
	readonly history: (pkg: Package, options: HistoryOptions<M>) => Document.Document;
	/**
	 * The resolved instructions of a plan. Cancelled instructions are omitted. Downgrade
	 * plans are titled as downgrades.
	 */
	readonly upgrade: (
		plan: Plan<Action.Any, Coverage>,
		options?: GuideOptions,
	) => Document.Document;
};

/** @since @next */
export type Options<M> = {
	readonly sections?: ReadonlyArray<SectionDefinition>;
	readonly plugins?: ReadonlyArray<Document.Plugin<M>>;
	/**
	 * The section for changes that no section selects, or `false` to leave them out. Its
	 * title defaults to "Changes" without `sections` and to "Other changes" with them.
	 */
	readonly other?: { readonly title: string } | false;
};

const paragraphsOf = (text: string): ReadonlyArray<Document.Paragraph> =>
	text
		.split(/\n\s*\n/)
		.map((part) => part.replace(/\s*\n\s*/g, " ").trim())
		.filter((part) => part !== "")
		.map((part) => Document.Paragraph(part));

/**
 * Selectors read metadata fields by name. Reading any field of an object yields a value
 * or `undefined`, so viewing the metadata as fields of type `unknown` is sound.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const selectable = (change: Change.Any) => change as Change.Change;

const changeList = (changes: ReadonlyArray<Change.Any>) =>
	Document.List(changes.map((change) => paragraphsOf(change.description)));

const knows = (pkg: Package, version: Version) =>
	pkg.history.versions.some((known) => known.id === version.id);

const releaseOrder = (versions: ReadonlyArray<Version>): ReadonlyArray<Version> => {
	const parsed = versions.map((version) => SemVer.parse(version.id));
	if (!parsed.every(Result.isSuccess)) return Arr.reverse(versions);

	return Arr.sort(
		versions,
		Order.flip(
			Order.mapInput(SemVer.Order, (version: Version) => SemVer.parseUnsafe(version.id)),
		),
	);
};

const occurrenceBlocks = (action: Action.Any, prose: Prose | undefined) =>
	prose === undefined ? [Document.Paragraph(action.description)] : guideBlocks(prose);

/** Builds guide blocks: prose becomes paragraphs; groups become lists. */
const guideBlocks = (
	items: ReadonlyArray<GuideItem | Prose[number]>,
): ReadonlyArray<Document.Block> => {
	const blocks: Array<Document.Block> = [];
	let current: Array<Document.Inline> = [];
	const flush = () => {
		const trimmed = trimInlines(current);
		if (trimmed.length > 0) blocks.push(Document.Paragraph(trimmed));
		current = [];
	};
	for (const item of items) {
		switch (item._tag) {
			case "Text": {
				const [first = "", ...rest] = item.text.split(/\n\s*\n/);
				current.push(Document.Text(first.replace(/\s*\n\s*/g, " ")));
				for (const part of rest) {
					flush();
					current.push(Document.Text(part.replace(/\s*\n\s*/g, " ")));
				}
				break;
			}
			case "ActionRef":
				current.push(Document.Text(item.action.description));
				break;
			case "Occurrence": {
				const { action, instruction } = item.occurrence;
				if (instruction === undefined && trimInlines(current).length > 0) {
					current.push(Document.Text(action.description));
					break;
				}
				flush();
				blocks.push(...occurrenceBlocks(action, instruction?.content));
				break;
			}
			case "Group":
				flush();
				blocks.push(Document.List(item.children.map((child) => guideBlocks(child))));
				break;
		}
	}
	flush();

	return blocks;
};

const trimInlines = (values: ReadonlyArray<Document.Inline>): ReadonlyArray<Document.Inline> => {
	const result = values.flatMap((value) =>
		value._tag === "Text" && value.value === "" ? [] : [value],
	);
	const first = result[0];
	const last = result.at(-1);
	if (first?._tag === "Text") result[0] = Document.Text(first.value.trimStart());
	if (last?._tag === "Text") result[result.length - 1] = Document.Text(last.value.trimEnd());

	return result.flatMap((value) => (value._tag === "Text" && value.value === "" ? [] : [value]));
};

const stepId = (step: Step) =>
	step.direction === "forward" ? step.migration.id : `${step.migration.id}/revert`;

/**
 * Configures sections and plugins for changelog documents. Without `sections`, a release
 * lists all of its changes in one "Changes" section.
 *
 * @example
 * ```ts
 * const changelog = Changelog.make<ReleaseMetadata>({
 * 	sections: [
 * 		Changelog.section("breaking", {
 * 			title: "Breaking changes",
 * 			select: (change) => change.metadata.breaking === true,
 * 		}),
 * 		Changelog.section("fixes", {
 * 			title: "Fixes",
 * 			select: (change) => change.metadata.kind === "fixed",
 * 		}),
 * 	],
 * 	plugins: [contributorsPlugin],
 * });
 * Markdown.render(changelog.history(widgets, { releases: [release100, release200] }));
 * ```
 *
 * @since @next
 */
export const make = <M = unknown>(options: Options<M> = {}): Changelog<M> => {
	const sections = options.sections ?? [];
	const plugins = options.plugins ?? [];
	const other = options.other ?? { title: sections.length === 0 ? "Changes" : "Other changes" };

	const changeSections = (
		changes: ReadonlyArray<Change.Any>,
	): ReadonlyArray<Document.Section> => {
		const grouped = new Map<string, Array<Change.Any>>();
		const unmatched: Array<Change.Any> = [];
		for (const change of changes) {
			const match = sections.find((definition) => definition.select(selectable(change)));
			if (match === undefined) {
				unmatched.push(change);
				continue;
			}
			const list = grouped.get(match.id) ?? [];
			list.push(change);
			grouped.set(match.id, list);
		}
		const result = sections.flatMap((definition) => {
			const matched = grouped.get(definition.id);
			if (matched === undefined) return [];

			return [
				Document.Section(definition.id, {
					title: definition.title,
					children: [changeList(matched)],
				}),
			];
		});
		if (other !== false && unmatched.length > 0) {
			result.push(
				Document.generatedSection("deltafold/other", {
					title: other.title,
					children: [changeList(unmatched)],
				}),
			);
		}

		return result;
	};

	const releaseSection = (context: Document.ReleaseContext<M>): Document.Section => {
		const base = asRelease(
			Document.Section(context.version.id, {
				title: context.version.id,
				children: changeSections(context.version.changes),
			}),
			context.version,
		);

		return insertAll(
			base,
			plugins.flatMap((plugin) =>
				plugin.scope === Document.Release
					? [{ at: plugin.at, blocks: blocksOf(plugin.resolve(context)) }]
					: [],
			),
		);
	};

	const requireKnown = (pkg: Package, releases: ReadonlyArray<Release<M>>) => {
		const unrelated = releases.flatMap((release) =>
			knows(pkg, release.version) ? [] : [release.version.id],
		);
		if (unrelated.length > 0) {
			throw new ReleaseMetadataError({
				reason: "unrelated",
				versions: unrelated,
				message: `Release metadata for ${unrelated.map((id) => `"${id}"`).join(", ")} does not belong to the history of "${pkg.name}".`,
			});
		}
	};

	return {
		sections,
		plugins,
		change: (input, changeOptions = {}) => {
			const changes = Arr.ensure(input);

			return {
				_tag: "Document",
				kind: "change",
				children: [
					Document.generatedSection("deltafold/unreleased", {
						title: changeOptions.title ?? "Unreleased",
						children: changeSections(changes),
					}),
				],
			};
		},
		release: (pkg, release) => {
			requireKnown(pkg, [release]);

			return {
				_tag: "Document",
				kind: "release",
				children: [
					releaseSection({
						package: pkg,
						version: release.version,
						metadata: release.metadata,
					}),
				],
			};
		},
		history: (pkg, historyOptions) => {
			const { releases } = historyOptions;
			requireKnown(pkg, releases);
			const byVersion = new Map<string, Release<M>>();
			const duplicates = new Set<string>();
			for (const release of releases) {
				if (byVersion.has(release.version.id)) duplicates.add(release.version.id);
				byVersion.set(release.version.id, release);
			}
			if (duplicates.size > 0) {
				throw new ReleaseMetadataError({
					reason: "duplicate",
					versions: [...duplicates],
					message: `Release metadata is supplied more than once for ${[...duplicates].map((id) => `"${id}"`).join(", ")}.`,
				});
			}
			const included = historyOptions.versions ?? pkg.history.versions;
			const missing = included.flatMap((version) =>
				byVersion.has(version.id) ? [] : [version.id],
			);
			if (missing.length > 0) {
				throw new ReleaseMetadataError({
					reason: "missing",
					versions: missing,
					message: `Release metadata is missing for ${missing.map((id) => `"${id}"`).join(", ")}. Supply an annotation for each, or limit the document with the \`versions\` option.`,
				});
			}

			const contexts = releaseOrder(included).flatMap((version) => {
				const release = byVersion.get(version.id);

				return release === undefined
					? []
					: [{ package: pkg, version, metadata: release.metadata }];
			});
			const root = insertAll(
				Document.generatedSection("deltafold/package", {
					title: pkg.name,
					children: contexts.map(releaseSection),
				}),
				plugins.flatMap((plugin) =>
					plugin.scope === Document.History
						? [
								{
									at: plugin.at,
									blocks: blocksOf(
										plugin.resolve({ package: pkg, releases: contexts }),
									),
								},
							]
						: [],
				),
			);

			return { _tag: "Document", kind: "history", children: [root] };
		},
		upgrade: (plan, guideOptions = {}) => {
			const verb =
				plan.direction === "downgrade"
					? "Downgrade"
					: plan.direction === "upgrade"
						? "Upgrade"
						: "Migrate";
			const subject =
				guideOptions.package === undefined ? "" : ` ${guideOptions.package.name}`;
			const shown = plan.steps.filter((step) => !step.omitted);
			const sharedEndpoints = (step: Step) =>
				shown.filter(
					(candidate) =>
						candidate.from.id === step.from.id && candidate.to.id === step.to.id,
				).length > 1;
			const stepSections = shown.map((step) =>
				Document.Section(stepId(step), {
					title: `${step.from.id} to ${step.to.id}${sharedEndpoints(step) ? ` (${step.migration.id})` : ""}`,
					children: guideBlocks(step.guide),
				}),
			);
			const children: Array<Document.Block> =
				stepSections.length === 0
					? [Document.Paragraph("No migration work is needed.")]
					: stepSections;
			if (guideOptions.explain === true && plan.explanations.length > 0) {
				children.push(
					Document.generatedSection("deltafold/explanations", {
						title: "Omitted instructions",
						children: [
							Document.List(
								plan.explanations.map((explanation) => {
									if (explanation._tag === "OmittedStep") {
										return explanation.reason === "noop"
											? `Migration "${explanation.migration.id}" needs no work.`
											: `Rules removed every action of migration "${explanation.migration.id}".`;
									}
									const removed = explanation.removed.map(
										(occurrence) => occurrence.action.description,
									);
									const produced = explanation.produced.map(
										(occurrence) => occurrence.action.description,
									);

									return produced.length === 0
										? `Rule "${explanation.rule.id}" cancelled: ${removed.join("; ")}.`
										: `Rule "${explanation.rule.id}" replaced ${removed.join("; ")} with ${produced.join("; ")}.`;
								}),
							),
						],
					}),
				);
			}

			return {
				_tag: "Document",
				kind: plan.direction === "downgrade" ? "downgrade" : "upgrade",
				children: [
					Document.generatedSection("deltafold/guide", {
						title: `${verb}${subject} from ${plan.from.id} to ${plan.to.id}`,
						children,
					}),
				],
			};
		},
	};
};
