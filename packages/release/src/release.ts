import { Array as Arr, Order, Result, SemVer } from "effect";

import { Version, type Change, type Package } from "deltafold";
import type { Policy, Proposal, Requirement } from "./dependents-policy.ts";
import { issue, PlanError } from "./error.ts";
import { highest, prerelease } from "./line.ts";
import { form, rewrite } from "./ranges.ts";
import {
	parse,
	type Calculation,
	type Line,
	type Participant,
	type Pre,
	type Strategy,
} from "./version-strategy.ts";

/**
 * A literal target version, or a strategy that calculates one. Literal targets belong to
 * one plan's input; group configuration takes strategies only.
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
	/**
	 * An independent strategy. The package then leaves the shared calculation. A group is
	 * reused across releases, so a fixed version is passed to one plan instead.
	 */
	readonly version?: Strategy<M>;
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
	/**
	 * The shared strategy for packages without their own. A fixed version would apply to
	 * every future release of the group, so literal targets are plan input only.
	 */
	readonly version: Strategy<M>;
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
	/** The version came from a shared calculation or the package's own setting. */
	readonly source: "shared" | "override";
	/**
	 * Why the package releases: its changes, a literal target, dependency updates, or
	 * alignment with the shared version.
	 */
	readonly reason: "changes" | "target" | "dependencies" | "alignment";
	/** Range edits in this package's manifest. */
	readonly dependencies: ReadonlyArray<DependencyUpdate>;
};

/**
 * A range edit in a dependent's manifest. Generated version modules record these as
 * release metadata, which `ReleaseChangelog.dependencies` renders.
 *
 * @since @next
 */
export type DependencyUpdate = {
	readonly dependent: string;
	readonly dependency: string;
	readonly field: string;
	readonly manifest: string;
	readonly from: string;
	readonly to: string;
	/** The dependency's new version. */
	readonly version: string;
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
	/** Every policy decision, sorted by dependent, field, dependency, and action. */
	readonly dependents: ReadonlyArray<Proposal>;
	/** Every range edit, including private dependents that do not release. */
	readonly dependencyUpdates: ReadonlyArray<DependencyUpdate>;
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
		const target = parse(setting);
		if (pre === undefined) return { version: setting, unchanged: "align" };
		// With pre, a literal is the stable version the prerelease line prepares.
		if (SemVer.isPrerelease(target)) {
			fail(
				"PrereleaseTarget",
				`With pre, the literal target is the stable version the line prepares; use ${SemVer.format(SemVer.release(target))} instead of ${setting}.`,
				[setting],
			);
		}

		return prerelease({
			participants,
			pre,
			baseline: highest(participants),
			bumps: [],
			target,
			unchanged: "align",
		});
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
	dependencies: ReadonlyArray<string>,
): Participant<M> => ({
	package: selection.package.name,
	previous: previous.id,
	changes: selection.changes,
	line: selection.line,
	dependencies,
});

const versionsOf = (planned: ReadonlyArray<PlannedVersion>) =>
	new Map(planned.map((entry) => [entry.package, entry.version.id]));

const byText = (select: (proposal: Proposal) => string) => Order.mapInput(Order.String, select);

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

	const policy = input.dependents ?? config.dependents;
	const requirements = input.requirements ?? [];
	// Packages that must release because of dependency updates, with the dependencies
	// responsible. Planning repeats until no new one appears.
	const required = new Map<string, Array<string>>();
	const dependenciesOf = (name: string): ReadonlyArray<string> => required.get(name) ?? [];

	const calculateVersions = () => {
		const explanations: Array<string> = [];
		const versions: Array<PlannedVersion> = [];
		const unchanged: Array<Unchanged> = [];

		const place = (
			group: ReadonlyArray<(typeof entries)[number]>,
			setting: VersionSetting<M>,
			source: PlannedVersion["source"],
		) => {
			if (group.length === 0) return;
			const hasIntent = group.some(
				(entry) =>
					entry.selection.changes.length > 0 ||
					dependenciesOf(entry.selection.package.name).length > 0,
			);
			if (!hasIntent && typeof setting !== "string") {
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
				group.map((entry) =>
					toParticipant(
						entry.selection,
						entry.previous,
						dependenciesOf(entry.selection.package.name),
					),
				),
				input.pre,
			);
			const target = parse(calculation.version);
			for (const entry of group) {
				const { selection, previous } = entry;
				const name = selection.package.name;
				const fromDependencies = dependenciesOf(name).length > 0;
				const intent = selection.changes.length > 0 || fromDependencies;
				if (SemVer.isLessThan(target, parse(previous.id))) {
					fail(
						"Downgrade",
						`${calculation.version} would downgrade ${name} from ${previous.id}.`,
						[name],
					);
				}
				if (
					!intent &&
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
					reason:
						typeof setting === "string"
							? "target"
							: selection.changes.length > 0
								? "changes"
								: fromDependencies
									? "dependencies"
									: "alignment",
					dependencies: [],
				});
			}
		};

		// A dependency-only release joins the calculation as patch intent. When unchanged
		// members drift, it is calculated on its own, from its own previous version.
		const assign = (
			group: ReadonlyArray<(typeof entries)[number]>,
			setting: VersionSetting<M>,
			source: PlannedVersion["source"],
		) => {
			const dependencyOnly = group.filter(
				(entry) =>
					entry.selection.changes.length === 0 &&
					dependenciesOf(entry.selection.package.name).length > 0,
			);
			const rest = group.filter((entry) => !dependencyOnly.includes(entry));
			if (typeof setting === "string" || dependencyOnly.length === 0 || group.length === 1) {
				place(group, setting, source);

				return;
			}
			const probe = rest.some((entry) => entry.selection.changes.length > 0)
				? rest
				: dependencyOnly;
			const mode = calculate(
				setting,
				probe.map((entry) =>
					toParticipant(
						entry.selection,
						entry.previous,
						dependenciesOf(entry.selection.package.name),
					),
				),
				input.pre,
			).unchanged;
			if (mode !== "drift") {
				place(group, setting, source);

				return;
			}
			place(rest, setting, source);
			for (const entry of dependencyOnly) place([entry], setting, source);
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

		return { versions, unchanged, explanations };
	};

	let calculated = calculateVersions();
	let proposals: ReadonlyArray<Proposal> = [];
	for (let round = 0; ; round++) {
		const released = versionsOf(calculated.versions);
		const result: unknown =
			policy?.({
				requirements: requirements.filter((requirement) =>
					released.has(requirement.dependency),
				),
				members,
				versions: released,
			}) ?? [];
		if (!Array.isArray(result)) {
			fail("InvalidPolicyResult", "A dependents policy must synchronously return proposals.");
		}
		// The array shape is checked above.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		proposals = result as ReadonlyArray<Proposal>;
		let added = false;
		for (const proposal of proposals) {
			if (proposal.action !== "release" || released.has(proposal.dependent)) continue;
			if (!members.includes(proposal.dependent)) {
				fail(
					"InvalidPolicyResult",
					`A policy cannot release ${proposal.dependent}, which is outside group "${release.group}".`,
					[proposal.dependent],
				);
			}
			const dependencies = required.get(proposal.dependent) ?? [];
			if (!dependencies.includes(proposal.dependency)) {
				dependencies.push(proposal.dependency);
				required.set(proposal.dependent, dependencies);
				added = true;
			}
		}
		if (!added) break;
		if (round > members.length) {
			fail(
				"InvalidPolicyResult",
				"Dependent releases did not settle; the dependents policy keeps proposing new work.",
			);
		}
		calculated = calculateVersions();
	}

	const released = versionsOf(calculated.versions);
	const sorted = Arr.sort(
		proposals,
		Order.combineAll([
			byText((proposal) => proposal.dependent),
			byText((proposal) => proposal.field),
			byText((proposal) => proposal.dependency),
			byText((proposal) => proposal.action),
		]),
	);
	const updates: Array<DependencyUpdate> = [];
	for (const proposal of sorted) {
		if (proposal.action !== "edit") continue;
		const range = form(proposal.range);
		const version = released.get(proposal.dependency);
		if (range._tag !== "Rewritable" || version === undefined) {
			return fail(
				"UnsupportedRange",
				`${proposal.manifest}: ${proposal.field}["${proposal.dependency}"] is "${proposal.range}"; only ^x.y.z, ~x.y.z, exact, and workspace: ranges can be updated.`,
				[proposal.manifest, proposal.dependent, proposal.dependency, proposal.field],
			);
		}
		updates.push({
			dependent: proposal.dependent,
			dependency: proposal.dependency,
			field: proposal.field,
			manifest: proposal.manifest,
			from: proposal.range,
			to: rewrite(range, version),
			version,
		});
	}

	return {
		_tag: "ReleasePlan",
		release,
		versions: calculated.versions.map((planned) => ({
			...planned,
			dependencies: updates.filter((update) => update.dependent === planned.package),
		})),
		unchanged: calculated.unchanged,
		dependents: sorted,
		dependencyUpdates: updates,
		replacements: input.replacements ?? config.replacements ?? [],
		explanations: calculated.explanations,
	};
};

/**
 * One change found on a prerelease line.
 *
 * @since @next
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
 * @since @next
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
 * const line = Release.prereleaseChanges(widgets, "2.0.0-rc.1");
 * ```
 *
 * @since @next
 */
export const prereleaseChanges = (
	pkg: Package.Package,
	from: Version.Version | string,
): Result.Result<PrereleaseChanges, PlanError> =>
	Result.try({
		try: () => {
			const id = typeof from === "string" ? from : from.id;
			const start =
				pkg.history.versions.find((version) => version.id === id) ??
				fail("UnknownPrevious", `${pkg.name}@${id} is not in the package history.`, [
					pkg.name,
					id,
				]);
			if (!SemVer.isPrerelease(parse(start.id))) {
				fail("NotPrerelease", `${pkg.name}@${id} is not a prerelease.`, [pkg.name, id]);
			}
			const line: Array<Version.Version> = [];
			let current: Version.Version | undefined = start;
			while (current !== undefined && SemVer.isPrerelease(parse(current.id))) {
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
			const onLine = (ids: ReadonlyArray<string>) => ids.filter((other) => found.has(other));

			return {
				package: pkg.name,
				from: id,
				stable: current?.id,
				versions: line.map((version) => version.id),
				changes: [...found.values()].map(({ change, versions }) => ({
					change,
					versions,
					reverts: onLine(change.reverts.map((reverted) => reverted.id)),
					revertedBy: [...found.values()]
						.filter((other) => other.change.reverts.some((r) => r.id === change.id))
						.map((other) => other.change.id),
				})),
			};
		},
		catch: (error) => {
			if (error instanceof PlanError) return error;
			throw error;
		},
	});

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
