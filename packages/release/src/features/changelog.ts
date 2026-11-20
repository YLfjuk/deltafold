import { Predicate } from "effect";

import { Changelog, Document } from "deltafold/changelog";
import { Bump } from "./semver-strategy.ts";

/**
 * One recorded range edit, as generated version modules write it.
 *
 * @since @next
 */
export type DependencyRecord = {
	readonly dependency: string;
	readonly field: string;
	readonly from: string;
	readonly to: string;
	readonly version: string;
};

/**
 * Release metadata that generated version modules attach for dependency updates.
 *
 * @since @next
 */
export type DependencyMetadata = { readonly dependencies?: ReadonlyArray<DependencyRecord> };

/**
 * Renders an "Updated Dependencies" section at the end of each release that recorded
 * dependency updates. Releases without them get nothing.
 *
 * @example
 * ```ts
 * const changelog = Changelog.make<MyMetadata & ReleaseChangelog.DependencyMetadata>({
 * 	plugins: [ReleaseChangelog.dependencies],
 * });
 * ```
 *
 * @since @next
 */
export const dependencies: Document.Plugin<DependencyMetadata> =
	Document.Plugin.make<DependencyMetadata>("@deltafold/release/dependencies", {
		scope: Document.Release,
		at: Document.Body.post,
		resolve: ({ metadata }) => {
			const records = metadata.dependencies ?? [];
			if (records.length === 0) return null;

			return Document.Section("updated-dependencies", {
				title: "Updated Dependencies",
				children: [
					Document.List(
						records.map((record) =>
							Document.Paragraph([
								Document.Code(`${record.dependency}@${record.version}`),
								Document.Text(` (${record.field}: ${record.from} to ${record.to})`),
							]),
						),
					),
				],
			});
		},
	});

const bumpSection = (bump: Bump, title: string) =>
	Changelog.section(`@deltafold/release/${bump}`, {
		title,
		select: (change) =>
			Predicate.hasProperty(change.metadata, "bump") && change.metadata.bump === bump,
	});

/**
 * Groups each release's changes under "Major Changes", "Minor Changes", and "Patch
 * Changes" by their `bump` metadata. Changes without a recognized bump fall into core's
 * "Other changes" section.
 *
 * @example
 * ```ts
 * const changelog = Changelog.make<ReleaseChange.Metadata & ReleaseChangelog.DependencyMetadata>({
 * 	sections: ReleaseChangelog.bySignificance,
 * 	plugins: [ReleaseChangelog.dependencies],
 * });
 * ```
 *
 * @since @next
 */
export const bySignificance: ReadonlyArray<Changelog.SectionDefinition> = [
	bumpSection(Bump.Major, "Major Changes"),
	bumpSection(Bump.Minor, "Minor Changes"),
	bumpSection(Bump.Patch, "Patch Changes"),
];
