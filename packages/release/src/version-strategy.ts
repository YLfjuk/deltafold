import { Array as Arr, Result, SemVer } from "effect";

import type { Change } from "deltafold";
import { issue, PlanError } from "./error.ts";
import type { Bump } from "./release-change.ts";

/**
 * The recorded state of a prerelease line. It is written next to each prerelease
 * version and supplied back as input; it is never inferred from a version label.
 *
 * @since @next
 */
export type Line = {
	/** The stable version the line started from. */
	readonly baseline: string;
	/** The strongest magnitude the line has accumulated. */
	readonly bump: Bump;
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
	/** `false` starts a new line; `true` continues the recorded one. */
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
	readonly line: Line | undefined;
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
	/** Present when `version` is a prerelease. */
	readonly line?: Line;
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
 * Parses a canonical SemVer version, failing with `InvalidVersion`.
 *
 * @since @next
 */
export const parse = (version: string): SemVer.SemVer => {
	const parsed = SemVer.parse(version);
	if (Result.isFailure(parsed) || SemVer.format(parsed.success) !== version) {
		throw new PlanError(
			issue("InvalidVersion", `"${version}" is not a canonical SemVer version.`, [version]),
		);
	}

	return parsed.success;
};

const magnitude: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };
const strongest = (bumps: ReadonlyArray<Bump>): Bump | undefined =>
	bumps.reduce<Bump | undefined>(
		(best, bump) => (best === undefined || magnitude[bump] > magnitude[best] ? bump : best),
		undefined,
	);

const bumpStable = (version: SemVer.SemVer, bump: Bump): SemVer.SemVer =>
	bump === "major"
		? SemVer.bumpMajor(version)
		: bump === "minor"
			? SemVer.bumpMinor(version)
			: SemVer.bumpPatch(version);

const sameLine = (a: Line, b: Line) =>
	a.baseline === b.baseline &&
	a.bump === b.bump &&
	a.target === b.target &&
	a.tag === b.tag &&
	a.counter === b.counter;

const identifier = /^[0-9A-Za-z-]+$/;

/**
 * A SemVer strategy over consumer-defined change metadata.
 *
 * Stable plans bump the baseline by the strongest change. Prerelease plans keep a line:
 * `continue` keeps the line's target unless stronger accumulated intent raises it, and
 * the counter restarts at 0 whenever the tag or the target changes.
 *
 * A stable plan from a prerelease baseline is stable promotion, whose contents are not
 * decided yet; it fails with `StablePromotionUnsupported`.
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
		const versions = participants.map((participant) => parse(participant.previous));
		if (!Arr.isReadonlyArrayNonEmpty(versions)) {
			throw new PlanError(
				issue("MissingMember", "A calculation needs at least one participant."),
			);
		}
		const highest = Arr.reduce(versions, versions[0], (a, b) => SemVer.max(a, b));
		const policy = options.baseline ?? "highest";
		if (policy === "require-matching" && new Set(versions.map(SemVer.format)).size > 1) {
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
		const baseline = typeof policy === "object" ? parse(policy.version) : highest;
		const unchanged = options.unchanged ?? "align";

		const bumps = participants.flatMap((participant) =>
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
		const intent = strongest(bumps);

		if (pre === undefined) {
			if (SemVer.isPrerelease(baseline)) {
				throw new PlanError(
					issue(
						"StablePromotionUnsupported",
						`A stable release from ${SemVer.format(baseline)} promotes a prerelease line. Choosing its contents is not supported yet; start or continue a prerelease, or pass an explicit target.`,
						participants.map((participant) => participant.package),
					),
				);
			}

			return {
				version: SemVer.format(
					intent === undefined ? baseline : bumpStable(baseline, intent),
				),
				unchanged,
			};
		}

		if (
			!identifier.test(pre.tag) ||
			/^\d+$/.test(pre.tag) ||
			typeof pre.continue !== "boolean"
		) {
			throw new PlanError(
				issue(
					"InvalidPre",
					"pre needs a non-numeric identifier tag and a boolean continue.",
					[pre.tag],
				),
			);
		}
		const lines = participants.map((participant) => participant.line);
		const prior = lines[0];
		if (pre.continue) {
			if (
				prior === undefined ||
				lines.some((line) => line === undefined || !sameLine(line, prior))
			) {
				throw new PlanError(
					issue(
						"PrereleaseContext",
						"Continuing needs one recorded prerelease line shared by every participant of the calculation. Start a line with continue: false, or calculate independent lines separately.",
						participants.map((participant) => participant.package),
					),
				);
			}
		} else if (SemVer.isPrerelease(baseline) && prior === undefined) {
			throw new PlanError(
				issue(
					"PrereleaseContext",
					`${SemVer.format(baseline)} is a prerelease without a recorded line, so its stable baseline is unknown.`,
					participants.map((participant) => participant.package),
				),
			);
		}

		const stable =
			prior !== undefined && (pre.continue || SemVer.isPrerelease(baseline))
				? parse(prior.baseline)
				: baseline;
		const accumulated =
			pre.continue && prior !== undefined ? strongest([...bumps, prior.bump]) : intent;
		if (accumulated === undefined) {
			throw new PlanError(
				issue("NoIntent", "Starting a prerelease line needs at least one change."),
			);
		}
		const target = SemVer.format(bumpStable(stable, accumulated));
		const counter =
			pre.continue && prior !== undefined && prior.target === target && prior.tag === pre.tag
				? prior.counter + 1
				: 0;
		const version = SemVer.format(
			SemVer.withPrerelease(SemVer.parseUnsafe(target), [pre.tag, counter]),
		);

		return {
			version,
			line: {
				baseline: SemVer.format(stable),
				bump: accumulated,
				target,
				tag: pre.tag,
				counter,
			},
			unchanged,
		};
	};
