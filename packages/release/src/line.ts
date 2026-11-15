import { Array as Arr, Result, SemVer } from "effect";

import type { Version } from "deltafold";
import { issue, PlanError } from "./error.ts";
import type { Bump } from "./release-change.ts";
import type { Calculation, Line, Participant, Pre } from "./version-strategy.ts";

// Prerelease line arithmetic shared by the SemVer strategy and literal plan targets.

/** Parses a canonical SemVer version, failing with `InvalidVersion`. */
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

export const strongest = (bumps: ReadonlyArray<Bump>): Bump | undefined =>
	bumps.reduce<Bump | undefined>(
		(best, bump) => (best === undefined || magnitude[bump] > magnitude[best] ? bump : best),
		undefined,
	);

export const bumpStable = (version: SemVer.SemVer, bump: Bump): SemVer.SemVer =>
	bump === "major"
		? SemVer.bumpMajor(version)
		: bump === "minor"
			? SemVer.bumpMinor(version)
			: SemVer.bumpPatch(version);

// Packages share a line when its target and tag match. Counters may differ: packages in a
// drifting group keep their own counter on one line.
const sameLine = (a: Line, b: Line) => a.target === b.target && a.tag === b.tag;

/**
 * The prerelease line a version is on, derived from its id and its ancestry: the tag and
 * counter come from `<target>-<tag>.<counter>`, and the baseline is the nearest stable
 * ancestor found through `previous`. Stable versions, and prereleases in another shape,
 * have no line.
 */
export const lineOf = (version: Version.Version): Line | undefined => {
	const parsed = parse(version.id);
	const [tag, counter, ...rest] = parsed.prerelease;
	if (typeof tag !== "string" || typeof counter !== "number" || rest.length > 0) return undefined;
	let ancestor = version.previous;
	while (ancestor !== undefined && SemVer.isPrerelease(parse(ancestor.id))) {
		ancestor = ancestor.previous;
	}

	return {
		baseline: ancestor?.id,
		target: SemVer.format(SemVer.release(parsed)),
		tag,
		counter,
	};
};

/** The id that a line's target and tag give with a counter. */
export const onLine = (target: string, tag: string, counter: number): string =>
	SemVer.format(SemVer.withPrerelease(parse(target), [tag, counter]));

const identifier = /^[0-9A-Za-z-]+$/;

const subjects = (participants: ReadonlyArray<Participant<object>>) =>
	participants.map((participant) => participant.package);

export const highest = (participants: ReadonlyArray<Participant<object>>): SemVer.SemVer => {
	const versions = participants.map((participant) => parse(participant.previous));
	if (!Arr.isReadonlyArrayNonEmpty(versions)) {
		throw new PlanError(
			issue("MissingMember", "A calculation needs at least one participant."),
		);
	}

	return Arr.reduce(versions, versions[0], (a, b) => SemVer.max(a, b));
};

/**
 * The one line of a calculation. Participants on a stable version join it; lines must
 * share their target and tag. It carries the highest counter and the highest known
 * baseline.
 */
const sharedLine = (participants: ReadonlyArray<Participant<object>>, purpose: string): Line => {
	const unknown = participants.filter(
		(participant) =>
			participant.line === undefined && SemVer.isPrerelease(parse(participant.previous)),
	);
	if (unknown.length > 0) {
		throw new PlanError(
			issue(
				"PrereleaseContext",
				`${purpose} needs prerelease versions shaped <target>-<tag>.<counter>; ${unknown.map((participant) => `${participant.package}@${participant.previous}`).join(", ")} is not.`,
				subjects(unknown),
			),
		);
	}
	const lines = participants.flatMap((participant) =>
		participant.line === undefined ? [] : [participant.line],
	);
	const [first] = lines;
	if (first === undefined || lines.some((line) => !sameLine(line, first))) {
		throw new PlanError(
			issue(
				"PrereleaseContext",
				`${purpose} needs one prerelease line; packages on a stable version join it, but lines with different targets or tags cannot share a calculation. Calculate independent lines separately.`,
				subjects(participants),
			),
		);
	}
	const baselines = lines.flatMap((line) =>
		line.baseline === undefined ? [] : [parse(line.baseline)],
	);
	const baseline = Arr.isReadonlyArrayNonEmpty(baselines)
		? SemVer.format(Arr.reduce(baselines, baselines[0], (a, b) => SemVer.max(a, b)))
		: undefined;

	return {
		...lines.reduce((best, line) => (line.counter > best.counter ? line : best), first),
		baseline,
	};
};

/** The line's target, raised when intent needs a stronger bump from its baseline. */
const raise = (line: Line, bumps: ReadonlyArray<Bump>): SemVer.SemVer => {
	const intent = strongest(bumps);
	const target = parse(line.target);
	if (intent === undefined || line.baseline === undefined) return target;

	return SemVer.max(target, bumpStable(parse(line.baseline), intent));
};

/**
 * The stable version of a promotion: the line's target, raised when the selected changes
 * need a stronger bump from the line's baseline. A target never lowers.
 */
export const promote = (
	participants: ReadonlyArray<Participant<object>>,
	bumps: ReadonlyArray<Bump>,
): SemVer.SemVer => raise(sharedLine(participants, "Promoting a prerelease to stable"), bumps);

/**
 * Starts or continues a prerelease line. Without `target`, the target comes from bump
 * intent; with it, the target is that stable version. Continuing never lowers the line's
 * target, and the counter restarts at 0 whenever the tag or the target changes.
 */
export const prerelease = (options: {
	readonly participants: ReadonlyArray<Participant<object>>;
	readonly pre: Pre;
	readonly baseline: SemVer.SemVer;
	readonly bumps: ReadonlyArray<Bump>;
	readonly target?: SemVer.SemVer;
	readonly unchanged: "align" | "drift";
}): Calculation => {
	const { participants, pre, baseline, bumps, target: fixed } = options;
	if (!identifier.test(pre.tag) || /^\d+$/.test(pre.tag) || typeof pre.continue !== "boolean") {
		throw new PlanError(
			issue("InvalidPre", "pre needs a non-numeric identifier tag and a boolean continue.", [
				pre.tag,
			]),
		);
	}
	const prior = pre.continue
		? sharedLine(participants, "Continuing a prerelease line")
		: participants.find((participant) => participant.line !== undefined)?.line;
	if (!pre.continue && SemVer.isPrerelease(baseline) && prior === undefined) {
		throw new PlanError(
			issue(
				"PrereleaseContext",
				`${SemVer.format(baseline)} is not shaped <target>-<tag>.<counter>, so its stable baseline is unknown.`,
				subjects(participants),
			),
		);
	}
	const stableBase =
		prior !== undefined && (pre.continue || SemVer.isPrerelease(baseline))
			? prior.baseline
			: SemVer.format(baseline);

	let target: SemVer.SemVer;
	if (fixed !== undefined) target = fixed;
	else if (pre.continue && prior !== undefined) target = raise(prior, bumps);
	else {
		const intent = strongest(bumps);
		if (intent === undefined) {
			throw new PlanError(
				issue("NoIntent", "Starting a prerelease line needs at least one change."),
			);
		}
		if (stableBase === undefined) {
			throw new PlanError(
				issue(
					"PrereleaseContext",
					`${SemVer.format(baseline)} has no stable ancestor to start a new line from; pass a literal target.`,
					subjects(participants),
				),
			);
		}
		target = bumpStable(parse(stableBase), intent);
	}
	const targetId = SemVer.format(target);
	const counter =
		pre.continue && prior !== undefined && prior.target === targetId && prior.tag === pre.tag
			? prior.counter + 1
			: 0;

	return { version: onLine(targetId, pre.tag, counter), unchanged: options.unchanged };
};
