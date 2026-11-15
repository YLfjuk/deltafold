import { SemVer } from "effect";

import type { Change } from "deltafold";
import { issue, PlanError } from "./error.ts";
import {
	bumpStable,
	highest,
	parse as parseVersion,
	prerelease,
	promote,
	strongest,
} from "./line.ts";
import type { Bump } from "./release-change.ts";

/**
 * A prerelease line, derived from a version id and its ancestry and never recorded:
 * `2.0.0-beta.3` is on the line with target `2.0.0`, tag `beta`, and counter 3. Packages
 * share a line when its target and tag match.
 *
 * @since @next
 */
export type Line = {
	/** The nearest stable ancestor, absent when the line starts at the root of the history. */
	readonly baseline: string | undefined;
	/** The stable version the line is preparing. */
	readonly target: string;
	readonly tag: string;
	readonly counter: number;
};

/**
 * The prerelease choice of one plan. Omit it for a stable release.
 *
 * @since @next
 */
export type Pre = {
	readonly tag: string;
	/** `false` starts a new line; `true` continues the line `previous` is on. */
	readonly continue: boolean;
};

/**
 * One participant of a calculation.
 *
 * @since @next
 */
export type Participant<M extends object> = {
	readonly package: string;
	readonly previous: string;
	readonly changes: ReadonlyArray<Change.Change<M>>;
	/** The line `previous` is on, derived from its id and ancestry. */
	readonly line: Line | undefined;
	/**
	 * Released dependencies whose range edits require this package to release. They are
	 * patch intent; they are not changes.
	 */
	readonly dependencies: ReadonlyArray<string>;
};

/** @since @next */
export type Context<M extends object> = {
	readonly participants: ReadonlyArray<Participant<M>>;
	readonly pre: Pre | undefined;
};

/** @since @next */
export type Calculation = {
	/** A canonical SemVer version. */
	readonly version: string;
	/**
	 * What happens to participants without changes when the version advances.
	 * Defaults to `"align"`.
	 */
	readonly unchanged?: "align" | "drift";
};

/**
 * Calculates one version for its participants. It must return synchronously: resolve
 * external data before planning.
 *
 * @since @next
 */
export type Strategy<M extends object> = (context: Context<M>) => Calculation;

/**
 * How the version a calculation starts from is chosen.
 *
 * - `"highest"`: the participant version with the highest SemVer precedence, whole.
 * - `"require-matching"`: every participant must have the same version.
 * - `{ version }`: an explicit version, used for calculation only.
 *
 * @since @next
 */
export type Baseline = "highest" | "require-matching" | { readonly version: string };

/** @since @next */
export type SemverOptions<M extends object> = {
	readonly bump: (change: Change.Change<M>) => Bump;
	readonly baseline?: Baseline;
	/** Participants without changes follow the new version by default. */
	readonly unchanged?: "align" | "drift";
};

/**
 * Parses a canonical SemVer version for the SemVer strategy, failing with
 * `InvalidVersion`. Build metadata (a `+...` suffix) is refused: it does not affect
 * precedence, so the strategy cannot order or calculate with it.
 *
 * @since @next
 */
export const parse = (version: string): SemVer.SemVer => {
	const parsed = parseVersion(version);
	if (parsed.build.length > 0) {
		throw new PlanError(
			issue(
				"InvalidVersion",
				`"${version}" has build metadata, which VersionStrategy.semver does not support.`,
				[version],
			),
		);
	}

	return parsed;
};

/**
 * A SemVer strategy over consumer-defined change metadata.
 *
 * Stable plans bump the baseline by the strongest change. Prerelease plans keep a line:
 * `continue` keeps the line's target unless stronger intent raises it, and
 * the counter restarts at 0 whenever the tag or the target changes.
 *
 * A stable plan from a prerelease baseline promotes its line: the version is the
 * line's target, raised by stronger selected changes. The plan's changes are exactly the
 * ones the stable version records; `Release.prereleaseChanges` lists the line's changes
 * to choose from.
 *
 * @example
 * ```ts
 * const strategy = VersionStrategy.semver({ bump: (change) => change.metadata.bump });
 * ```
 *
 * @since @next
 */
export const semver =
	<M extends object>(options: SemverOptions<M>): Strategy<M> =>
	({ participants, pre }) => {
		for (const participant of participants) parse(participant.previous);
		const top = highest(participants);
		const policy = options.baseline ?? "highest";
		if (
			policy === "require-matching" &&
			new Set(participants.map((participant) => participant.previous)).size > 1
		) {
			throw new PlanError(
				issue(
					"BaselineMismatch",
					"The baseline policy requires matching versions.",
					participants.map(
						(participant) => `${participant.package}@${participant.previous}`,
					),
				),
			);
		}
		const baseline = typeof policy === "object" ? parse(policy.version) : top;
		const unchanged = options.unchanged ?? "align";

		const bumps: Array<Bump> = participants.flatMap((participant) =>
			participant.changes.map((change) => {
				const bump: unknown = options.bump(change);
				if (bump !== "major" && bump !== "minor" && bump !== "patch") {
					throw new PlanError(
						issue(
							"InvalidBump",
							`Change "${change.id}" has bump ${String(bump)}; use major, minor, or patch.`,
							[change.id],
						),
					);
				}

				return bump;
			}),
		);
		// A release required only by dependency updates is patch intent.
		if (participants.some((participant) => participant.dependencies.length > 0))
			bumps.push("patch");

		if (pre !== undefined) return prerelease({ participants, pre, baseline, bumps, unchanged });
		if (SemVer.isPrerelease(baseline)) {
			return { version: SemVer.format(promote(participants, bumps)), unchanged };
		}
		const intent = strongest(bumps);

		return {
			version: SemVer.format(intent === undefined ? baseline : bumpStable(baseline, intent)),
			unchanged,
		};
	};
