import { Result, SemVer } from "effect";

import { Version, type Change, type Package } from "deltafold";
import type { Policy, Proposal, Requirement } from "./dependents-policy.ts";
import { issue, PlanError } from "./error.ts";
import {
	parse,
	type Calculation,
	type Line,
	type Participant,
	type Pre,
	type Strategy,
} from "./version-strategy.ts";

/**
 * A literal target version, or a strategy that calculates one.
 *
 * @since @next
 */
export type VersionSetting<M extends object> = string | Strategy<M>;

/**
 * Where a package's files live, relative to the working directory.
 *
 * @since @next
 */
export type Files = {
	/** The package manifest whose `version` field the release updates. */
	readonly manifest?: string;
	/** The directory that receives one generated module per version. */
	readonly versions: string;
};

/** @since @next */
export type Registration<M extends object> = {
	readonly package: Package.Package;
	/** An independent version or strategy. The package then leaves the shared calculation. */
	readonly version?: VersionSetting<M>;
	readonly files?: Files;
};

/**
 * Replaces a literal token with the version a package receives in this release.
 *
 * @since @next
 */
export type Replacement = {
	/** Glob patterns, relative to the working directory. */
	readonly files: ReadonlyArray<string>;
	readonly exclude?: ReadonlyArray<string>;
	/** The literal token to replace, such as `@next`. */
	readonly match: string;
	readonly versionOf: Package.Package;
};

/** @since @next */
export type Config<M extends object> = {
	readonly packages: ReadonlyArray<Registration<M>>;
	/** The change factory whose metadata type policies and strategies receive. */
	readonly change: Change.Definition<M>;
	/** The shared version setting for packages without their own. */
	readonly version: VersionSetting<M>;
	readonly dependents?: Policy;
	readonly replacements?: ReadonlyArray<Replacement>;
	/** The export name of generated version modules. Defaults to `version`. */
	readonly exportName?: string;
};

/**
 * One package's part of a plan.
 *
 * @since @next
 */
export type Selection<M extends object> = {
	readonly package: Package.Package;
	/** The released version this release descends from. It must be in the package history. */
	readonly previous: Version.Version | string;
	readonly changes: ReadonlyArray<Change.Change<M>>;
	/** The recorded prerelease line of `previous`, when it is a prerelease. */
	readonly line?: Line;
	/** Overrides the registered and shared version setting for this run. */
	readonly version?: VersionSetting<M>;
};

/**
 * Plan input. Options replace the configured value at the same level; arrays replace,
 * and an empty array disables. `pre` exists only here.
 *
 * @since @next
 */
export type Input<M extends object> = {
	/** Every registered package, with empty changes for unchanged ones. */
	readonly packages: ReadonlyArray<Selection<M>>;
	readonly version?: VersionSetting<M>;
	readonly dependents?: Policy;
	readonly replacements?: ReadonlyArray<Replacement>;
	readonly requirements?: ReadonlyArray<Requirement>;
	readonly pre?: Pre;
};

/**
 * A version this plan creates.
 *
 * @since @next
 */
export type PlannedVersion = {
	readonly package: string;
	/** Its `previous` is the package's own previous version, never a shared baseline. */
	readonly version: Version.Version;
	readonly line: Line | undefined;
	/** The version came from a shared calculation, an override, or a literal target. */
	readonly source: "shared" | "override";
};

/** @since @next */
export type Unchanged = {
	readonly package: string;
	readonly version: string;
	readonly reason: "no-changes" | "drift";
};

/** @since @next */
export type Plan<M extends object = any> = {
	readonly _tag: "ReleasePlan";
	readonly release: Release<M>;
	readonly versions: ReadonlyArray<PlannedVersion>;
	readonly unchanged: ReadonlyArray<Unchanged>;
	readonly dependents: ReadonlyArray<Proposal>;
	readonly replacements: ReadonlyArray<Replacement>;
	readonly explanations: ReadonlyArray<string>;
};

/** @since @next */
export type Release<M extends object = any> = {
	readonly _tag: "Release";
	readonly group: string;
	readonly config: Config<M>;
	/** Calculates a plan. It reads and writes nothing. */
	readonly plan: (input: Input<M>) => Result.Result<Plan<M>, PlanError>;
};

const fail = (...args: Parameters<typeof issue>): never => {
	throw new PlanError(issue(...args));
};

const resolvePrevious = <M extends object>(selection: Selection<M>): Version.Version => {
	const id = typeof selection.previous === "string" ? selection.previous : selection.previous.id;
	const known = selection.package.history.versions.find((version) => version.id === id);

	return (
		known ??
		fail(
			"UnknownPrevious",
			`${selection.package.name}@${id} is not in the package history, so its ancestry is unknown.`,
			[selection.package.name, id],
		)
	);
};

const calculate = <M extends object>(
	setting: VersionSetting<M>,
	participants: ReadonlyArray<Participant<M>>,
	pre: Pre | undefined,
): Calculation => {
	if (typeof setting === "string") {
		if (pre !== undefined) {
			fail(
				"ExplicitTargetWithPre",
				`The literal target ${setting} is already a complete version; omit pre or use a strategy.`,
				[setting],
			);
		}
		parse(setting);

		return { version: setting, unchanged: "align" };
	}
	const result: unknown = setting({ participants, pre });
	if (
		typeof result !== "object" ||
		result === null ||
		"then" in result ||
		!("version" in result) ||
		typeof result.version !== "string"
	) {
		return fail(
			"InvalidStrategyResult",
			"A version strategy must synchronously return { version }.",
		);
	}
	// The shape is checked above; `version` is validated next.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const calculation = result as Calculation;
	parse(calculation.version);

	return calculation;
};

const toParticipant = <M extends object>(
	selection: Selection<M>,
	previous: Version.Version,
): Participant<M> => ({
	package: selection.package.name,
	previous: previous.id,
	changes: selection.changes,
	line: selection.line,
});

const buildPlan = <M extends object>(release: Release<M>, input: Input<M>): Plan<M> => {
	const { config } = release;
	const members = config.packages.map((registration) => registration.package.name);
	const selected = input.packages.map((selection) => selection.package.name);
	const duplicates = selected.filter((name, index) => selected.indexOf(name) !== index);
	if (duplicates.length > 0) fail("DuplicatePackage", "Select each package once.", duplicates);
	const outside = selected.filter((name) => !members.includes(name));
	if (outside.length > 0)
		fail("OutsideGroup", `Group "${release.group}" does not contain these packages.`, outside);
	// Every member is supplied, so an aligned unchanged package has a known previous version.
	const missing = members.filter((name) => !selected.includes(name));
	if (missing.length > 0) {
		fail(
			"MissingMember",
			"Supply every member of the group, with empty changes for unchanged packages.",
			missing,
		);
	}

	const entries = input.packages.map((selection) => {
		const registration = config.packages.find(
			(candidate) => candidate.package.name === selection.package.name,
		);

		return {
			selection,
			previous: resolvePrevious(selection),
			override: selection.version ?? registration?.version,
		};
	});

	const explanations: Array<string> = [];
	const versions: Array<PlannedVersion> = [];
	const unchanged: Array<Unchanged> = [];

	const assign = (
		group: ReadonlyArray<(typeof entries)[number]>,
		setting: VersionSetting<M>,
		source: PlannedVersion["source"],
	) => {
		if (group.length === 0) return;
		const hasChanges = group.some((entry) => entry.selection.changes.length > 0);
		if (!hasChanges && typeof setting !== "string") {
			for (const entry of group) {
				unchanged.push({
					package: entry.selection.package.name,
					version: entry.previous.id,
					reason: "no-changes",
				});
			}
			explanations.push(
				`No changes for ${group.map((entry) => entry.selection.package.name).join(", ")}; nothing to calculate.`,
			);

			return;
		}
		const calculation = calculate(
			setting,
			group.map((entry) => toParticipant(entry.selection, entry.previous)),
			input.pre,
		);
		const target = parse(calculation.version);
		for (const entry of group) {
			const { selection, previous } = entry;
			const name = selection.package.name;
			if (SemVer.isLessThan(target, parse(previous.id))) {
				fail(
					"Downgrade",
					`${calculation.version} would downgrade ${name} from ${previous.id}.`,
					[name],
				);
			}
			if (
				selection.changes.length === 0 &&
				(calculation.unchanged === "drift" || calculation.version === previous.id)
			) {
				unchanged.push({
					package: name,
					version: previous.id,
					reason: calculation.unchanged === "drift" ? "drift" : "no-changes",
				});
				continue;
			}
			if (calculation.version === previous.id) {
				fail(
					"ExistingVersion",
					`${name}@${previous.id} already exists; new contents need a new version.`,
					[name],
				);
			}
			versions.push({
				package: name,
				version: Version.make(calculation.version, {
					previous,
					changes: selection.changes,
				}),
				line: calculation.line,
				source,
			});
		}
	};

	assign(
		entries.filter((entry) => entry.override === undefined),
		input.version ?? config.version,
		"shared",
	);
	for (const entry of entries) {
		if (entry.override !== undefined) assign([entry], entry.override, "override");
	}
	if (entries.some((entry) => entry.override !== undefined)) {
		explanations.push(
			"Packages with their own version setting do not take part in the shared calculation.",
		);
	}

	const released = versions.map((planned) => planned.package);
	const policy = input.dependents ?? config.dependents;
	const dependents =
		policy?.({
			requirements: (input.requirements ?? []).filter((requirement) =>
				released.includes(requirement.dependency),
			),
			members,
			released,
		}) ?? [];

	return {
		_tag: "ReleasePlan",
		release,
		versions,
		unchanged,
		dependents,
		replacements: input.replacements ?? config.replacements ?? [],
		explanations,
	};
};

/**
 * Declares a bounded release group with a stable identifier. Plans can only release its
 * registered packages.
 *
 * @example
 * ```ts
 * const release = Release.make("widgets", {
 * 	packages: [{ package: widgets, files: { manifest: "packages/widgets/package.json", versions: "packages/widgets/versions" } }],
 * 	change: ReleaseChange.define(),
 * 	version: VersionStrategy.semver({ bump: (change) => change.metadata.bump }),
 * });
 * const plan = release.plan({ packages: [{ package: widgets, previous: "1.5.2", changes: [retries] }] });
 * ```
 *
 * @since @next
 */
export const make = <M extends object>(group: string, config: Config<M>): Release<M> => {
	if (group.trim() === "")
		throw new PlanError(issue("GroupId", "A release group needs a stable identifier."));
	if ("pre" in config) {
		throw new PlanError(
			issue("InvalidPre", "pre is a per-plan choice and cannot be configured on a group."),
		);
	}
	const names = config.packages.map((registration) => registration.package.name);
	const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
	if (duplicates.length > 0)
		throw new PlanError(issue("DuplicatePackage", "Register each package once.", duplicates));

	const release: Release<M> = {
		_tag: "Release",
		group,
		config,
		plan: (input) =>
			Result.try({
				try: () => buildPlan(release, input),
				catch: (error) => {
					if (error instanceof PlanError) return error;
					throw error;
				},
			}),
	};

	return release;
};

/**
 * Plans once without keeping the group. It takes the same stable group identifier.
 *
 * @since @next
 */
export const plan = <M extends object>(
	group: string,
	config: Config<M>,
	input: Input<M>,
): Result.Result<Plan<M>, PlanError> =>
	Result.flatMap(
		Result.try({
			try: () => make(group, config),
			catch: (error) => {
				if (error instanceof PlanError) return error;
				throw error;
			},
		}),
		(release) => release.plan(input),
	);
