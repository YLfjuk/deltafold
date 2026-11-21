import { Predicate } from "effect";

import { Changelog, Document } from "deltafold/changelog";
import * as PackageConfig from "../configs/package.config.ts";
import { Bump } from "./semver-strategy.ts";

/**
 * One recorded range edit, as generated version modules write it.
 *
 * @since 0.0.1
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
 * @since 0.0.1
 */
export type DependencyMetadata = { readonly dependencies?: ReadonlyArray<DependencyRecord> };

/** @since 0.0.1 */
export type DependenciesOptions = {
	/** Also render each edited manifest field and its range change. Defaults to `false`. */
	readonly verbose?: boolean;
};

/**
 * Renders an "Updated Dependencies" section at the end of each release that recorded
 * dependency updates, one `name@version` entry per update. Releases without them get
 * nothing. With `verbose`, each entry also shows the edited field and its range change.
 *
 * @example
 * ```ts
 * import { ReleaseChangelog } from "@deltafold/release/changelog";
 * import { Changelog } from "deltafold/changelog";
 *
 * const changelog = Changelog.make<ReleaseChangelog.DependencyMetadata>({
 * 	plugins: [ReleaseChangelog.dependencies()],
 * });
 * ```
 *
 * @since 0.0.1
 */
export const dependencies = (
	options: DependenciesOptions = {},
): Document.Plugin<DependencyMetadata> =>
	Document.Plugin.make<DependencyMetadata>(`${PackageConfig.name}/dependencies`, {
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
								...(options.verbose === true
									? [
											Document.Text(
												` (${record.field}: ${record.from} to ${record.to})`,
											),
										]
									: []),
							]),
						),
					),
				],
			});
		},
	});

const bumpSection = (bump: Bump, title: string) =>
	Changelog.section(`${PackageConfig.name}/${bump}`, {
		title,
		select: (change) =>
			Predicate.hasProperty(change.metadata, "bump") && change.metadata.bump === bump,
	});

/**
 * Groups each release's changes under "Major Changes", "Minor Changes", and "Patch
 * Changes" by their `bump` metadata. Changes without a recognized bump fall into core's
 * "Other changes" section.
 *
 * The changelog's type parameter is release metadata; the sections read each change's
 * own `bump`.
 *
 * @example
 * ```ts
 * import { ReleaseChangelog } from "@deltafold/release/changelog";
 * import { Changelog } from "deltafold/changelog";
 *
 * const changelog = Changelog.make<ReleaseChangelog.DependencyMetadata>({
 * 	sections: ReleaseChangelog.bySignificance,
 * 	plugins: [ReleaseChangelog.dependencies()],
 * });
 * ```
 *
 * @since 0.0.1
 */
export const bySignificance: ReadonlyArray<Changelog.SectionDefinition> = [
	bumpSection(Bump.Major, "Major Changes"),
	bumpSection(Bump.Minor, "Minor Changes"),
	bumpSection(Bump.Patch, "Patch Changes"),
];
