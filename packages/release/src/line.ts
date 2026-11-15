import { Array as Arr, Result, SemVer } from "effect";

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

/** The magnitude of the step from one stable version to a higher one. */
const impliedBump = (from: SemVer.SemVer, to: SemVer.SemVer): Bump =>
	to.major > from.major ? "major" : to.minor > from.minor ? "minor" : "patch";

// Counters may differ: packages in a drifting group keep their own counter on one line.
const sameLine = (a: Line, b: Line) =>
	a.baseline === b.baseline && a.bump === b.bump && a.target === b.target && a.tag === b.tag;

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

/** The recorded line every participant shares, or `undefined` when none has one. */
/**
 * The one recorded line of a calculation. Participants without a line join it; lines may
 * differ only in their counters, and the highest counter is returned.
 */
const sharedLine = (participants: ReadonlyArray<Participant<object>>, purpose: string): Line => {
	const lines = participants.flatMap((participant) =>
		participant.line === undefined ? [] : [participant.line],
	);
	const [first] = lines;
	if (first === undefined || lines.some((line) => !sameLine(line, first))) {
		throw new PlanError(
			issue(
				"PrereleaseContext",
				`${purpose} needs one recorded prerelease line; participants without one join it, but different lines cannot share a calculation. Calculate independent lines separately.`,
				subjects(participants),
			),
		);
	}

	return lines.reduce((best, line) => (line.counter > best.counter ? line : best), first);
};

/**
 * The stable version of a promotion: the line's target, raised when the selected changes
 * need a stronger bump from the line's baseline.
 */
export const promote = (
	participants: ReadonlyArray<Participant<object>>,
	bumps: ReadonlyArray<Bump>,
): SemVer.SemVer => {
	const line = sharedLine(participants, "Promoting a prerelease to stable");
	const calculated = bumpStable(
		parse(line.baseline),
		strongest([...bumps, line.bump]) ?? line.bump,
	);

	return SemVer.max(parse(line.target), calculated);
};

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
				`${SemVer.format(baseline)} is a prerelease without a recorded line, so its stable baseline is unknown.`,
				subjects(participants),
			),
		);
	}
	const stable =
		prior !== undefined && (pre.continue || SemVer.isPrerelease(baseline))
			? parse(prior.baseline)
			: baseline;
	const carried = pre.continue && prior !== undefined ? [prior.bump] : [];

	let target: SemVer.SemVer;
	let bump: Bump | undefined;
	if (fixed !== undefined) {
		target = fixed;
		bump = strongest([...bumps, ...carried, impliedBump(stable, fixed)]);
	} else {
		bump = strongest([...bumps, ...carried]);
		if (bump === undefined) {
			throw new PlanError(
				issue("NoIntent", "Starting a prerelease line needs at least one change."),
			);
		}
		const calculated = bumpStable(stable, bump);
		target =
			pre.continue && prior !== undefined
				? SemVer.max(parse(prior.target), calculated)
				: calculated;
	}
	const targetId = SemVer.format(target);
	const counter =
		pre.continue && prior !== undefined && prior.target === targetId && prior.tag === pre.tag
			? prior.counter + 1
			: 0;

	return {
		version: SemVer.format(SemVer.withPrerelease(target, [pre.tag, counter])),
		line: {
			baseline: SemVer.format(stable),
			bump: bump ?? "patch",
			target: targetId,
			tag: pre.tag,
			counter,
		},
		unchanged: options.unchanged,
	};
};
