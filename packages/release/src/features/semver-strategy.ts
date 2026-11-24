import { Array as Arr, Result, Schema, SemVer } from "effect";

import type { Change, Package, Version as DeltafoldVersion } from "deltafold";
import { diagnose } from "../foundation/diagnostic.ts";
import { PlanError } from "../foundation/error.ts";
import * as VersionScheme from "../foundation/version-scheme.ts";
import * as VersionStrategy from "../foundation/version-strategy.ts";
import type { ValueOf } from "../types.ts";

/**
 * Release magnitudes. A prerelease stage is chosen per plan, never per change.
 *
 * @since 0.0.1
 */
export const Bump = {
	Major: "major",
	Minor: "minor",
	Patch: "patch",
} as const;

/** @since 0.0.1 */
export type Bump = ValueOf<typeof Bump>;

const isBump = Schema.is(Schema.Enum(Bump));

/**
 * The SemVer value type, from Effect. Effect marks its SemVer module unstable, so this
 * type may change with Effect releases.
 *
 * @since 0.0.1
 */
export type Version = SemVer.SemVer;

/**
 * Canonical SemVer ids. Build metadata is accepted by the scheme, so literal targets such
 * as `1.6.0+build.4` pass through; the strategy refuses to calculate from it.
 *
 * @since 0.0.1
 */
export const scheme: VersionScheme.VersionScheme<Version> = VersionScheme.make({
	name: "semver",
	decode: (id) => {
		const parsed = SemVer.parse(id);
		if (Result.isFailure(parsed) || SemVer.format(parsed.success) !== id) {
			return Result.fail(`"${id}" is not a canonical SemVer version.`);
		}

		return Result.succeed(parsed.success);
	},
	encode: SemVer.format,
	order: SemVer.Order,
});

/**
 * The prerelease choice of one plan. Omit it for a stable release.
 *
 * @since 0.0.1
 */
export type Pre = {
	readonly tag: string;
	/** `false` starts a new line; `true` continues the line `previous` is on. */
	readonly continue: boolean;
};

/**
 * Per-plan input of the SemVer strategy.
 *
 * @since 0.0.1
 */
export type Input = {
	readonly pre?: Pre;
	/**
	 * A stable target. With `pre`, the line prepares it (`3.0.0` with `beta` gives
	 * `3.0.0-beta.0`); without `pre`, it is the version itself.
	 */
	readonly target?: string;
};

/**
 * The input schema, for reading input from outside TypeScript.
 *
 * @since 0.0.1
 */
export const InputSchema = Schema.Struct({
	pre: Schema.optionalKey(Schema.Struct({ tag: Schema.String, continue: Schema.Boolean })),
	target: Schema.optionalKey(Schema.String),
});

/**
 * A prerelease line, derived from a version and its ancestry and never recorded:
 * `2.0.0-beta.3` is on the line with target `2.0.0`, tag `beta`, and counter 3. Packages
 * share a line when its target and tag match.
 *
 * @since 0.0.1
 */
export type Line = {
	/** The nearest stable ancestor, absent when the line starts at the root of the history. */
	readonly baseline: Version | undefined;
	/** The stable version the line is preparing. */
	readonly target: Version;
	readonly tag: string;
	readonly counter: number;
};

/**
 * Details the SemVer strategy attaches to each planned version.
 *
 * @since 0.0.1
 */
export type Details = { readonly line: Line | undefined };

/**
 * A line as plain strings, for JSON output.
 *
 * @since 0.0.1
 */
export type EncodedLine = {
	readonly baseline: string | undefined;
	readonly target: string;
	readonly tag: string;
	readonly counter: number;
};

/**
 * Encodes a line with string versions. Effect SemVer values do not serialize to JSON as
 * ids, so use this for output.
 *
 * @since 0.0.1
 */
export const encodeLine = (line: Line): EncodedLine => ({
	baseline: line.baseline === undefined ? undefined : SemVer.format(line.baseline),
	target: SemVer.format(line.target),
	tag: line.tag,
	counter: line.counter,
});

/**
 * The line a version is on. Its tag and counter come from `<target>-<tag>.<counter>`, and
 * its baseline is the first stable version in `ancestry`. Stable versions, and
 * prereleases in another shape, have no line.
 *
 * @since 0.0.1
 */
export const lineOf = (version: Version, ancestry: ReadonlyArray<Version>): Line | undefined => {
	const [tag, counter, ...rest] = version.prerelease;
	if (typeof tag !== "string" || typeof counter !== "number" || rest.length > 0) return undefined;

	return {
		baseline: ancestry.find((ancestor) => !SemVer.isPrerelease(ancestor)),
		target: SemVer.release(version),
		tag,
		counter,
	};
};

/**
 * How the version a calculation starts from is chosen.
 *
 * - `"highest"`: the participant version with the highest SemVer precedence, whole.
 * - `"require-matching"`: every participant must have the same version.
 * - `{ version }`: an explicit version, used for calculation only. Alignment does not
 *   apply to it; each package's downgrade check still does.
 *
 * @since 0.0.1
 */
export type Baseline = "highest" | "require-matching" | { readonly version: string };

/** @since 0.0.1 */
export type Options<M extends object> = {
	readonly bump: (change: Change.Change<M>) => Bump;
	readonly baseline?: Baseline;
	/** Participants without changes follow the new version by default. */
	readonly unchanged?: "align" | "drift";
	/** The strategy name shown in diagnostics. Defaults to `"semver"`. */
	readonly name?: string;
};

type Participant<M extends object> = VersionStrategy.Participant<M, Version>;

const dependencyOnly = (participant: Participant<object>) =>
	participant.changes.length === 0 && participant.dependencies.length > 0;

const magnitudeByBump = {
	[Bump.Patch]: 1,
	[Bump.Minor]: 2,
	[Bump.Major]: 3,
} as const satisfies Record<Bump, number>;

const strongest = (bumps: ReadonlyArray<Bump>): Bump | undefined =>
	bumps.reduce<Bump | undefined>(
		(best, bump) =>
			best === undefined || magnitudeByBump[bump] > magnitudeByBump[best] ? bump : best,
		undefined,
	);

const bumpStable = (version: Version, bump: Bump): Version =>
	bump === Bump.Major
		? SemVer.bumpMajor(version)
		: bump === Bump.Minor
			? SemVer.bumpMinor(version)
			: SemVer.bumpPatch(version);

const identifier = /^[0-9A-Za-z-]+$/;
const label = (participant: Participant<object>) =>
	`${participant.package}@${SemVer.format(participant.previous)}`;
const subjects = (participants: ReadonlyArray<Participant<object>>) =>
	participants.map((participant) => participant.package);
const failWith = diagnose;

const decode = (id: string): Version =>
	Result.getOrElse(scheme.decode(id), (message) => failWith("InvalidVersion", message, [id]));

/** A version the strategy calculates from or to; build metadata is refused. */
const calculable = (version: Version, role: string): Version =>
	SemVer.hasBuild(version)
		? failWith(
				"InvalidVersion",
				`${role} ${SemVer.format(version)} has build metadata, which the SemVer strategy cannot calculate with.`,
				[SemVer.format(version)],
			)
		: version;

const ownLine = (participant: Participant<object>) =>
	lineOf(participant.previous, participant.ancestry);

// Packages share a line when its target and tag match; counters may differ.
const sameLine = (a: Line, b: Line) => SemVer.equals(a.target, b.target) && a.tag === b.tag;

/**
 * The one line of a calculation. Participants on a stable version join it; lines must
 * share their target and tag. It carries the highest counter and highest known baseline.
 */
const sharedLine = (participants: ReadonlyArray<Participant<object>>, purpose: string): Line => {
	const unshaped = participants.filter(
		(participant) =>
			ownLine(participant) === undefined && SemVer.isPrerelease(participant.previous),
	);
	if (unshaped.length > 0) {
		failWith(
			"PrereleaseContext",
			`${purpose} needs prerelease versions shaped <target>-<tag>.<counter>; ${unshaped.map(label).join(", ")} is not.`,
			subjects(unshaped),
		);
	}
	const lines = participants.flatMap((participant) => ownLine(participant) ?? []);
	const [first] = lines;
	if (first === undefined || lines.some((line) => !sameLine(line, first))) {
		return failWith(
			"PrereleaseContext",
			`${purpose} needs one prerelease line; packages on a stable version join it, but lines with different targets or tags cannot share a calculation. Calculate independent lines separately.`,
			subjects(participants),
		);
	}
	const baselines = lines.flatMap((line) => line.baseline ?? []);

	return {
		...lines.reduce((best, line) => (line.counter > best.counter ? line : best), first),
		baseline: Arr.isReadonlyArrayNonEmpty(baselines)
			? calculable(
					Arr.reduce(baselines, baselines[0], (a, b) => SemVer.max(a, b)),
					"The line's baseline",
				)
			: undefined,
	};
};

/**
 * The line participants are on when a new line starts, if any. Lines with different
 * targets or tags cannot share a calculation, here as when continuing.
 */
const startingLine = (participants: ReadonlyArray<Participant<object>>): Line | undefined => {
	const lines = participants.flatMap((participant) => ownLine(participant) ?? []);
	const [first] = lines;
	if (first !== undefined && lines.some((line) => !sameLine(line, first))) {
		failWith(
			"PrereleaseContext",
			"Starting a prerelease line needs participants on at most one prerelease line; lines with different targets or tags cannot share a calculation. Calculate independent lines separately.",
			subjects(participants),
		);
	}

	return first?.baseline === undefined
		? first
		: { ...first, baseline: calculable(first.baseline, "The line's baseline") };
};

/** The line's target, raised when intent needs a stronger bump from its baseline. */
const raise = (line: Line, bumps: ReadonlyArray<Bump>): Version => {
	const intent = strongest(bumps);
	if (intent === undefined || line.baseline === undefined) return line.target;

	return SemVer.max(line.target, bumpStable(line.baseline, intent));
};

const onLine = (target: Version, tag: string, counter: number): Version =>
	SemVer.withPrerelease(target, [tag, counter]);

/**
 * A SemVer strategy over consumer-defined change metadata.
 *
 * Stable plans bump the baseline by the strongest change. Prerelease plans keep a line:
 * `continue` keeps the line's target unless stronger intent raises it, and the counter
 * restarts at 0 whenever the tag or the target changes. A stable plan from a prerelease
 * promotes its line. In a drifting group, packages on one line keep their own counters,
 * and a package released only for its dependencies gets its own patch on a stable plan.
 * Build metadata on a previous version is refused.
 *
 * @example
 * ```ts
 * const strategy = SemVerStrategy.make({ bump: (change) => change.metadata.bump });
 * ```
 *
 * @since 0.0.1
 */
export const make = <M extends object>(
	options: Options<M>,
): VersionStrategy.VersionStrategy<M, Version, Input | undefined, Details> => {
	const unchanged = options.unchanged ?? "align";

	const calculate = (participants: ReadonlyArray<Participant<M>>, input: Input): Version => {
		const built = participants.filter((participant) => SemVer.hasBuild(participant.previous));
		if (built.length > 0) {
			failWith(
				"InvalidVersion",
				`${built.map(label).join(", ")} has build metadata, which the SemVer strategy cannot calculate from.`,
				built.map(label),
			);
		}
		const versions = participants.map((participant) => participant.previous);
		if (!Arr.isReadonlyArrayNonEmpty(versions)) {
			return failWith("MissingMember", "A calculation needs at least one participant.");
		}
		const policy = options.baseline ?? "highest";
		if (policy === "require-matching" && versions.some((v) => !SemVer.equals(v, versions[0]))) {
			failWith(
				"BaselineMismatch",
				"The baseline policy requires matching versions.",
				participants.map(label),
			);
		}
		const baseline = calculable(
			typeof policy === "object"
				? decode(policy.version)
				: Arr.reduce(versions, versions[0], (a, b) => SemVer.max(a, b)),
			"The baseline",
		);

		const bumps: Array<Bump> = participants.flatMap((participant) =>
			participant.changes.map((change) => {
				const bump: unknown = options.bump(change);
				if (!isBump(bump)) {
					return failWith(
						"InvalidBump",
						`Change "${change.id}" has bump ${String(bump)}; use major, minor, or patch.`,
						[change.id],
					);
				}
				return bump;
			}),
		);
		// A release required only by dependency updates is patch intent.
		if (participants.some((participant) => participant.dependencies.length > 0))
			bumps.push(Bump.Patch);

		const target =
			input.target === undefined ? undefined : calculable(decode(input.target), "The target");
		const pre = input.pre;
		if (pre === undefined) {
			if (target !== undefined) return target;
			if (SemVer.isPrerelease(baseline)) {
				return raise(sharedLine(participants, "Promoting a prerelease to stable"), bumps);
			}
			const intent = strongest(bumps);
			return intent === undefined ? baseline : bumpStable(baseline, intent);
		}

		if (
			!identifier.test(pre.tag) ||
			/^\d+$/.test(pre.tag) ||
			typeof pre.continue !== "boolean"
		) {
			failWith(
				"InvalidPre",
				"pre needs a non-numeric identifier tag and a boolean continue.",
				[pre.tag],
			);
		}
		if (target !== undefined && SemVer.isPrerelease(target)) {
			failWith(
				"PrereleaseTarget",
				`With pre, the target is the stable version the line prepares; use ${SemVer.format(SemVer.release(target))} instead of ${SemVer.format(target)}.`,
				[SemVer.format(target)],
			);
		}
		const prior = pre.continue
			? sharedLine(participants, "Continuing a prerelease line")
			: startingLine(participants);
		if (!pre.continue && SemVer.isPrerelease(baseline) && prior === undefined) {
			failWith(
				"PrereleaseContext",
				`${SemVer.format(baseline)} is not shaped <target>-<tag>.<counter>, so its stable baseline is unknown.`,
				subjects(participants),
			);
		}
		const stableBase =
			prior !== undefined && (pre.continue || SemVer.isPrerelease(baseline))
				? prior.baseline
				: baseline;

		let next: Version;
		if (target !== undefined) next = target;
		else if (pre.continue && prior !== undefined) next = raise(prior, bumps);
		else {
			const intent = strongest(bumps);
			if (intent === undefined) {
				return failWith(
					"NoIntent",
					"Starting a prerelease line needs at least one change.",
				);
			}
			if (stableBase === undefined) {
				return failWith(
					"PrereleaseContext",
					`${SemVer.format(baseline)} has no stable ancestor to start a new line from; pass a target.`,
					subjects(participants),
				);
			}
			next = bumpStable(stableBase, intent);
		}
		const counter =
			pre.continue &&
			prior !== undefined &&
			SemVer.equals(prior.target, next) &&
			prior.tag === pre.tag
				? prior.counter + 1
				: 0;

		return onLine(next, pre.tag, counter);
	};

	const detailsFor = (participant: Participant<M>, version: Version): Details => ({
		line: lineOf(version, [version, ...participant.ancestry]),
	});

	return VersionStrategy.make<M, Version, Input | undefined, Details>({
		name: options.name ?? "semver",
		scheme,
		input: Schema.toStandardSchemaV1(Schema.UndefinedOr(InputSchema)),
		calculate: ({ participants, input }) => {
			const settings = input ?? {};
			const drift = unchanged === "drift";

			// Stable drifting releases give dependency-only packages their own patch.
			const own =
				drift && settings.pre === undefined && settings.target === undefined
					? participants.filter(dependencyOnly)
					: [];
			const core = participants.filter((participant) => !own.includes(participant));
			const shared = calculate(core.length > 0 ? core : participants, settings);
			const sharedLineOfResult = lineOf(shared, []);

			const versionFor = (participant: Participant<M>): Version => {
				if (own.includes(participant)) return calculate([participant], settings);
				// Drifting packages on a shared line keep their own counters.
				if (!drift || settings.pre === undefined || sharedLineOfResult === undefined) {
					return shared;
				}
				const line = ownLine(participant);
				const counter =
					settings.pre.continue &&
					line !== undefined &&
					sameLine(line, sharedLineOfResult)
						? line.counter + 1
						: 0;
				return onLine(sharedLineOfResult.target, sharedLineOfResult.tag, counter);
			};

			const [first] = participants;
			return {
				version: shared,
				unchanged,
				...(first === undefined ? {} : { details: detailsFor(first, shared) }),
				versions: participants.map((participant) => {
					const version = versionFor(participant);
					return {
						package: participant.package,
						version,
						details: detailsFor(participant, version),
					};
				}),
			};
		},
	});
};

/**
 * One change found on a prerelease line.
 *
 * @since 0.0.1
 */
export type LineChange = {
	readonly change: Change.Any;
	/** The prerelease versions that contain it, oldest first. */
	readonly versions: ReadonlyArray<string>;
	/** Changes on the line that revert it. */
	readonly revertedBy: ReadonlyArray<string>;
	/** Changes on the line that it reverts. */
	readonly reverts: ReadonlyArray<string>;
};

/**
 * The changes of a prerelease line since its last stable ancestor.
 *
 * @since 0.0.1
 */
export type PrereleaseChanges = {
	readonly package: string;
	readonly from: string;
	/** The last stable ancestor, absent when the line starts at the root of the history. */
	readonly stable: string | undefined;
	/** The prerelease versions of the line, oldest first. */
	readonly versions: ReadonlyArray<string>;
	/** Each change once, in order of first appearance. */
	readonly changes: ReadonlyArray<LineChange>;
};

/**
 * Lists the changes on the prerelease line that ends at `from`, back to its last stable
 * ancestor, following `previous`. It chooses nothing: a stable plan records exactly the
 * changes passed to it, so this listing is for deciding which ones to pass.
 *
 * @example
 * ```ts
 * const line = SemVerStrategy.prereleaseChanges(widgets, "2.0.0-rc.1");
 * ```
 *
 * @since 0.0.1
 */
export const prereleaseChanges = (
	pkg: Package.Package,
	from: DeltafoldVersion.Version | string,
): Result.Result<PrereleaseChanges, PlanError> =>
	Result.try({
		try: () => {
			const id = typeof from === "string" ? from : from.id;
			const start =
				pkg.history.versions.find((version) => version.id === id) ??
				failWith("UnknownPrevious", `${pkg.name}@${id} is not in the package history.`, [
					pkg.name,
					id,
				]);
			if (!SemVer.isPrerelease(decode(start.id))) {
				failWith("NotPrerelease", `${pkg.name}@${id} is not a prerelease.`, [pkg.name, id]);
			}
			const line: Array<DeltafoldVersion.Version> = [];
			let current: DeltafoldVersion.Version | undefined = start;
			while (current !== undefined && SemVer.isPrerelease(decode(current.id))) {
				line.unshift(current);
				current = current.previous;
			}
			const found = new Map<string, { change: Change.Any; versions: Array<string> }>();
			for (const version of line) {
				for (const change of version.changes) {
					const entry = found.get(change.id) ?? { change, versions: [] };
					entry.versions.push(version.id);
					found.set(change.id, entry);
				}
			}
			const presentOnLine = (ids: ReadonlyArray<string>) =>
				ids.filter((other) => found.has(other));

			return {
				package: pkg.name,
				from: id,
				stable: current?.id,
				versions: line.map((version) => version.id),
				changes: [...found.values()].map(({ change, versions }) => ({
					change,
					versions,
					reverts: presentOnLine(change.reverts.map((reverted) => reverted.id)),
					revertedBy: [...found.values()].flatMap((other) =>
						other.change.reverts.some((r) => r.id === change.id) ? other.change.id : [],
					),
				})),
			};
		},
		catch: (error) => {
			if (error instanceof PlanError) return error;
			throw error;
		},
	});
