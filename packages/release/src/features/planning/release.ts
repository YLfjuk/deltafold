import { Array as Arr, Order, Predicate, Result } from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";

import { Package, Version, type Change } from "deltafold";
import { isDiagnostic } from "../../foundation/diagnostic.ts";
import { issue, PlanError } from "../../foundation/error.ts";
import { form, rewrite } from "../../foundation/npm/ranges.ts";
import * as VersionStrategy from "../../foundation/version-strategy.ts";
import type { Policy, Proposal, Requirement } from "./dependents-policy.ts";

type AnyPackage = Package.Package<any>;

/**
 * Where a package's files live. Relative paths resolve against the release config file's
 * directory; absolute paths must be inside the workspace. `ReleaseFiles.at` builds this
 * from a package directory.
 *
 * @since @next
 */
export type Files = {
	/** The package manifest whose `version` field the release reads and updates. */
	readonly manifest: string;
	/** The directory that receives one generated module per version. */
	readonly versions: string;
};

/** @since @next */
export type Registration<M extends object> = {
	readonly package: AnyPackage;
	/**
	 * An independent strategy, possibly with another scheme. The package then leaves the
	 * shared calculation. A group is reused across releases, so a fixed version is passed
	 * to one plan instead.
	 */
	readonly version?: VersionStrategy.VersionStrategy<M, any, any, any>;
	readonly files: Files;
};

/**
 * Replaces a literal token with the version a package receives in this release.
 *
 * @since @next
 */
export type Replacement = {
	/** Glob patterns, relative to the release config file's directory. */
	readonly files: ReadonlyArray<string>;
	readonly exclude?: ReadonlyArray<string>;
	/** The literal token to replace, such as `@next`. */
	readonly match: string;
	readonly versionOf: AnyPackage;
};

/** @since @next */
export type Config<
	M extends object,
	V,
	I,
	D,
	Rs extends ReadonlyArray<Registration<M>> = ReadonlyArray<Registration<M>>,
> = {
	readonly packages: Rs;
	/** The change factory whose metadata type policies and strategies receive. */
	readonly change: Change.Definition<M>;
	/**
	 * The shared strategy for packages without their own. A fixed version would apply to
	 * every future release of the group, so literal targets are plan input only.
	 */
	readonly version: VersionStrategy.VersionStrategy<M, V, I, D>;
	readonly dependents?: Policy;
	readonly replacements?: ReadonlyArray<Replacement>;
	/** The export name of generated version modules. Defaults to `version`. */
	readonly exportName?: string;
};

// An unmatched registration, `never`, falls back to the shared strategy.
type StrategyOf<R, Shared> = [R] extends [never]
	? Shared
	: R extends { readonly version: infer S extends VersionStrategy.Any }
		? S
		: Shared;
type RegistrationFor<Rs extends ReadonlyArray<unknown>, P> = Extract<
	Rs[number],
	{ readonly package: P }
>;
type PackageOf<E> = E extends { readonly package: infer P } ? P : E;
type NameOf<P> = P extends Package.Package<any, infer N> ? N : string;
type OwnsStrategy<R, E> = [E] extends [{ readonly version: VersionStrategy.Any }]
	? true
	: [R] extends [never]
		? false
		: [R] extends [{ readonly version: VersionStrategy.Any }]
			? true
			: false;

/**
 * An `input` field: required when the strategy's input type does not accept `undefined`.
 *
 * @since @next
 */
export type InputField<I> = undefined extends I ? { readonly input?: I } : { readonly input: I };

type RequiresInput<S> = [S] extends [never]
	? false
	: S extends VersionStrategy.Any
		? undefined extends VersionStrategy.InputOf<S>
			? false
			: true
		: false;

/**
 * The message a per-package `input` gets when the package shares the group calculation.
 *
 * @since @next
 */
export type SharedInputError<N extends string> =
	`${N} shares the group calculation; add version: <strategy> to calculate it with its own input`;

/**
 * One package's part of a plan, checked against its registration.
 *
 * @since @next
 */
export type Selection<M extends object, R, Shared, E> = SelectionFields<M, R, Shared, E> &
	(OwnsStrategy<R, E> extends true
		? InputField<VersionStrategy.InputOf<StrategyOf<R, Shared>>>
		: {
				/** Shared packages take the plan's `input`. */
				readonly input?: SharedInputError<NameOf<PackageOf<E>>>;
			});

type SelectionFields<M extends object, R, Shared, E> = {
	// Inference reads the whole entry, not its package.
	readonly package: PackageOf<NoInfer<E>>;
	/**
	 * The released version this release descends from. It must be in the package history.
	 * Omitted, it is the history's single head, the one version nothing descends from;
	 * planning refuses when there are several.
	 */
	readonly previous?: Version.Version | string;
	/** Omitted means no changes. */
	readonly changes?: ReadonlyArray<Change.Change<M>>;
	/**
	 * An exact version for this run, decoded by the package's scheme, or a strategy that
	 * keeps the registered strategy's version and input types.
	 */
	readonly version?:
		| string
		| VersionStrategy.VersionStrategy<
				M,
				VersionStrategy.VersionOf<StrategyOf<R, Shared>>,
				VersionStrategy.InputOf<StrategyOf<R, Shared>>,
				VersionStrategy.DetailsOf<StrategyOf<R, Shared>>
		  >;
};

/**
 * An element of a plan's `packages`: a registered package, bare, or a selection for it.
 *
 * @since @next
 */
export type Entry<Rs extends ReadonlyArray<Registration<any>>> =
	| Rs[number]["package"]
	| { readonly package: Rs[number]["package"] };

type Checked<
	M extends object,
	Rs extends ReadonlyArray<Registration<M>>,
	Shared,
	E,
> = E extends AnyPackage
	? // A bare package cannot carry the input its own strategy requires.
		RequiresInput<StrategyOf<RegistrationFor<Rs, E>, undefined>> extends true
		? Selection<M, RegistrationFor<Rs, E>, Shared, { readonly package: NoInfer<E> }>
		: E
	: Selection<M, RegistrationFor<Rs, PackageOf<E>>, Shared, E>;

/**
 * A plan's `packages`: every registered package, each bare or as a selection checked
 * against its registration. A bare Package stands for a member with no changes and no
 * overrides, descending from the single head of its history.
 *
 * @since @next
 */
export type Packages<
	M extends object,
	V,
	I,
	D,
	Rs extends ReadonlyArray<Registration<M>>,
	Ps extends ReadonlyArray<unknown>,
> = {
	readonly [K in keyof Ps]: Checked<M, Rs, VersionStrategy.VersionStrategy<M, V, I, D>, Ps[K]>;
};

/**
 * The plan options besides `packages` and `requirements`.
 *
 * @since @next
 */
export type Options<M extends object, V, I, D> = {
	/**
	 * An exact version for every shared package, decoded by the shared scheme, or a strategy
	 * replacing the shared one for this run.
	 */
	readonly version?: string | VersionStrategy.VersionStrategy<M, V, I, D>;
	readonly dependents?: Policy;
	readonly replacements?: ReadonlyArray<Replacement>;
	/**
	 * Input for the shared strategy, such as SemVer's `{ pre }`, validated by its schema.
	 * Required when the strategy's input type does not accept `undefined`.
	 */
} & InputField<I>;

/**
 * Plan input. Options replace the configured value at the same level; arrays replace,
 * and an empty array disables.
 *
 * @since @next
 */
export type Input<
	M extends object,
	V,
	I,
	D,
	Rs extends ReadonlyArray<Registration<M>>,
	Ps extends ReadonlyArray<unknown>,
> = Options<M, V, I, D> & {
	readonly packages: Packages<M, V, I, D, Rs, Ps>;
	readonly requirements?: ReadonlyArray<Requirement>;
};

/**
 * A version this plan creates.
 *
 * @since @next
 */
export type PlannedVersion<D = unknown> = {
	readonly package: string;
	/** Its `previous` is the package's own previous version, never a shared baseline. */
	readonly version: Version.Version;
	/** What the strategy reported about this version, such as SemVer's prerelease line. */
	readonly details: D | undefined;
	/** The version came from a shared calculation or the package's own setting. */
	readonly source: "shared" | "override";
	/**
	 * Why the package releases: its changes, a literal target, dependency updates, or
	 * alignment with the shared version.
	 */
	readonly reason: "changes" | "target" | "dependencies" | "alignment";
	/** Range edits in this package's manifest. */
	readonly dependencies: ReadonlyArray<DependencyUpdate>;
	/** Whether `previous` was stated, or taken from the single head of the history. */
	readonly previousFrom: PreviousFrom;
};

/**
 * Where a member's previous version came from.
 *
 * @since @next
 */
export type PreviousFrom = "stated" | "history-head";

/**
 * A range edit in a dependent's manifest. Generated version modules record these as
 * release metadata, which `ReleaseChangelog.dependencies()` renders.
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
	readonly previousFrom: PreviousFrom;
};

/** @since @next */
export type Plan<M extends object = any, D = unknown> = {
	readonly _tag: "ReleasePlan";
	readonly release: Release<M>;
	readonly versions: ReadonlyArray<PlannedVersion<D>>;
	readonly unchanged: ReadonlyArray<Unchanged>;
	/** Every policy decision, sorted by dependent, field, dependency, and action. */
	readonly dependents: ReadonlyArray<Proposal>;
	/** Every range edit, including private dependents that do not release. */
	readonly dependencyUpdates: ReadonlyArray<DependencyUpdate>;
	readonly replacements: ReadonlyArray<Replacement>;
	/** Each member's file locations, copied when the plan was made. */
	readonly files: ReadonlyMap<string, Files>;
	/** The export name of generated version modules. */
	readonly exportName: string;
	readonly explanations: ReadonlyArray<string>;
};

/**
 * The details a plan's versions can carry: the shared strategy's and every registered
 * strategy's.
 *
 * @since @next
 */
export type PlanDetails<D, Rs extends ReadonlyArray<Registration<any>>> =
	| D
	| VersionStrategy.DetailsOf<NonNullable<Rs[number]["version"]>>;

/** @since @next */
export type Release<
	M extends object = any,
	V = any,
	I = any,
	D = any,
	Rs extends ReadonlyArray<Registration<M>> = ReadonlyArray<Registration<M>>,
> = {
	readonly _tag: "Release";
	readonly group: string;
	readonly config: Config<M, V, I, D, Rs>;
	/** Calculates a plan. It reads and writes nothing. */
	readonly plan: <const Ps extends ReadonlyArray<Entry<Rs>>>(
		input: Input<M, V, I, D, Rs, Ps>,
	) => Result.Result<Plan<M, PlanDetails<D, Rs>>, PlanError>;
};

const fail = (...args: Parameters<typeof issue>): never => {
	throw new PlanError(issue(...args));
};

/**
 * The versions of a package's history that no other version descends from.
 *
 * @example
 * ```ts
 * Release.heads(widgets).map((version) => version.id); // ["2.0.0", "1.5.3"]
 * ```
 *
 * @since @next
 */
export const heads = (pkg: AnyPackage): ReadonlyArray<Version.Version> => {
	const parents = new Set(pkg.history.versions.flatMap((version) => version.previous?.id ?? []));

	return pkg.history.versions.filter((version) => !parents.has(version.id));
};

// The planner works on loosely typed values; the public types check them at the call site.
type LooseStrategy = VersionStrategy.Any;
type LooseSetting = string | LooseStrategy;
type LooseRelease = {
	readonly group: string;
	readonly config: Config<object, unknown, unknown, unknown>;
};
type LooseInput = {
	readonly packages: ReadonlyArray<unknown>;
	readonly version?: LooseSetting;
	readonly input?: unknown;
	readonly dependents?: Policy;
	readonly replacements?: ReadonlyArray<Replacement>;
	readonly requirements?: ReadonlyArray<Requirement>;
};
type Member = {
	readonly package: AnyPackage;
	readonly previous: Version.Version | string | undefined;
	readonly changes: ReadonlyArray<Change.Any>;
	readonly version: unknown;
	readonly input: unknown;
};

const memberOf = (entry: unknown): Member => {
	if (Package.isPackage(entry)) {
		return {
			package: entry,
			previous: undefined,
			changes: [],
			version: undefined,
			input: undefined,
		};
	}
	// Plan input elements are packages or selections; the public types guarantee the shape.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const selection = entry as {
		readonly package: AnyPackage;
		readonly previous?: Version.Version | string;
		readonly changes?: ReadonlyArray<Change.Any>;
		readonly version?: unknown;
		readonly input?: unknown;
	};

	return {
		package: selection.package,
		previous: selection.previous,
		changes: selection.changes ?? [],
		version: selection.version,
		input: selection.input,
	};
};

const strategyOrLiteral = (value: unknown, where: string): LooseSetting | undefined => {
	if (value === undefined || typeof value === "string") return value;
	if (VersionStrategy.isVersionStrategy(value)) return value;

	return fail(
		"NotAStrategy",
		`${where} is not a version strategy. Build strategies with VersionStrategy.make.`,
		[where],
	);
};

const statedPrevious = (member: Member, id: string): Version.Version =>
	member.package.history.versions.find((version) => version.id === id) ??
	fail(
		"UnknownPrevious",
		`${member.package.name}@${id} is not in the package history, so its ancestry is unknown.`,
		[member.package.name, id],
	);

/** Resolves every member's previous version, reporting all ambiguous members at once. */
const previousVersions = (members: ReadonlyArray<Member>) => {
	const resolved = new Map<string, { previous: Version.Version; from: PreviousFrom }>();
	const ambiguous: Array<string> = [];
	const empty: Array<string> = [];
	for (const member of members) {
		const name = member.package.name;
		if (member.previous !== undefined) {
			const id = typeof member.previous === "string" ? member.previous : member.previous.id;
			resolved.set(name, { previous: statedPrevious(member, id), from: "stated" });
			continue;
		}
		const found = heads(member.package);
		const [only] = found;
		if (only !== undefined && found.length === 1) {
			resolved.set(name, { previous: only, from: "history-head" });
		} else if (found.length === 0) empty.push(name);
		else ambiguous.push(name, ...found.map((version) => version.id));
	}
	if (empty.length > 0) {
		fail(
			"NoPrevious",
			`${empty.join(", ")} ${empty.length === 1 ? "has" : "have"} an empty history, so there is no previous version to descend from. Register an initial version in the package history first.`,
			empty,
		);
	}
	if (ambiguous.length > 0) {
		const described = members
			.filter((member) => member.previous === undefined && heads(member.package).length > 1)
			.map(
				(member) =>
					`${member.package.name} has several heads (${heads(member.package)
						.map((version) => version.id)
						.join(", ")})`,
			);
		fail(
			"PreviousRequired",
			`${described.join("; ")}. State { package, previous } to choose one.`,
			ambiguous,
		);
	}

	return resolved;
};

const decodeWith = (strategy: LooseStrategy, id: string, subject: string): unknown =>
	Result.getOrElse(strategy.scheme.decode(id), (message) =>
		fail("InvalidVersion", `${subject}: ${message}`, [subject, id]),
	);

/** `version`, then its own previous, and so on, decoded by the strategy's scheme. */
const ancestryOf = (strategy: LooseStrategy, version: Version.Version, name: string) => {
	const ancestry: Array<unknown> = [];
	for (let current: Version.Version | undefined = version; current; current = current.previous) {
		ancestry.push(decodeWith(strategy, current.id, name));
	}

	return ancestry;
};

const describeIssue = (entry: StandardSchemaV1.Issue) => {
	const path = (entry.path ?? []).map((segment) =>
		String(typeof segment === "object" ? segment.key : segment),
	);
	return path.length === 0 ? entry.message : `${path.join(".")}: ${entry.message}`;
};

/**
 * Whether a callback returned a thenable (including a Promise from another realm). Planning
 * is synchronous and never awaits it, so a rejection is handled here instead of surfacing
 * as an unhandled rejection after the refusal.
 */
const ignoreAsync = (result: unknown): boolean => {
	if (!Predicate.isPromiseLike(result)) return false;
	result.then(undefined, () => undefined);

	return true;
};

/**
 * Validates strategy input with its schema, synchronously, and returns the schema's
 * output. A strategy without a schema takes no input.
 */
const validateInput = (strategy: LooseStrategy, value: unknown, where: string): unknown => {
	const schema = strategy.input;
	if (schema === undefined) {
		if (value !== undefined) {
			fail("InvalidInput", `${strategy.name} takes no input, but ${where} is set.`, [
				strategy.name,
			]);
		}
		return undefined;
	}
	let result: unknown;
	try {
		result = schema["~standard"].validate(value);
	} catch (error) {
		return fail(
			"InvalidInput",
			`${strategy.name}'s input schema threw: ${error instanceof Error ? error.message : String(error)}`,
			[strategy.name],
		);
	}
	if (ignoreAsync(result)) {
		return fail(
			"InvalidInput",
			`${strategy.name}'s input schema validates asynchronously; planning needs synchronous validation.`,
			[strategy.name],
		);
	}
	// A synchronous Standard Schema result.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const outcome = result as StandardSchemaV1.Result<unknown>;
	if (outcome.issues !== undefined) {
		return fail(
			"InvalidInput",
			`${where} is not valid input for ${strategy.name}: ${outcome.issues.map(describeIssue).join("; ")}`,
			[strategy.name],
		);
	}

	return outcome.value;
};

/** Runs a strategy, turning refusals and foreign throws into plan errors. */
const run = (
	strategy: LooseStrategy,
	context: VersionStrategy.Context<object, unknown, unknown>,
): VersionStrategy.Calculation<unknown, unknown> => {
	let result: unknown;
	try {
		result = strategy(context);
	} catch (error) {
		if (isDiagnostic(error)) throw error;
		if (error instanceof VersionStrategy.StrategyRefusal) {
			return fail("StrategyRefused", `${strategy.name}: ${error.message}`, [
				strategy.name,
				...error.subjects,
			]);
		}
		return fail(
			"InvalidStrategyResult",
			`${strategy.name} threw instead of refusing: ${error instanceof Error ? error.message : String(error)}`,
			[strategy.name],
		);
	}
	if (
		ignoreAsync(result) ||
		typeof result !== "object" ||
		result === null ||
		"then" in result ||
		!("version" in result) ||
		result.version === undefined
	) {
		return fail(
			"InvalidStrategyResult",
			`${strategy.name} must synchronously return { version }.`,
			[strategy.name],
		);
	}
	return result;
};

const versionsOf = (planned: ReadonlyArray<PlannedVersion>) =>
	new Map(planned.map((entry) => [entry.package, entry.version.id]));

const byText = (select: (proposal: Proposal) => string) => Order.mapInput(Order.String, select);

const buildPlan = (release: LooseRelease, input: LooseInput, owner: Release): Plan => {
	const { config } = release;
	const members = config.packages.map((registration) => registration.package.name);
	const selections = input.packages.map(memberOf);
	const selected = selections.map((selection) => selection.package.name);
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

	const planVersion = strategyOrLiteral(input.version, "The plan's version");
	const sharedStrategy: LooseStrategy =
		typeof planVersion === "function" ? planVersion : config.version;
	const sharedLiteral = typeof planVersion === "string" ? planVersion : undefined;
	const previousOf = previousVersions(selections);
	const entries = selections.map((selection) => {
		const name = selection.package.name;
		const registration = config.packages.find((candidate) => candidate.package.name === name);
		const resolved = previousOf.get(name);
		if (resolved === undefined) {
			return fail("UnknownPrevious", `${name} has no previous version.`, [name]);
		}
		const chosen = strategyOrLiteral(selection.version, `${name}'s version`);
		const registered = strategyOrLiteral(registration?.version, `${name}'s registered version`);
		// A package with its own strategy, or a literal of its own, leaves the shared calculation.
		const ownStrategy =
			typeof chosen === "object" || typeof chosen === "function"
				? chosen
				: typeof registered === "function"
					? registered
					: undefined;
		const literal = typeof chosen === "string" ? chosen : undefined;

		return {
			selection,
			previous: resolved.previous,
			previousFrom: resolved.from,
			strategy: ownStrategy ?? sharedStrategy,
			literal,
			ownInput: selection.input,
			override: ownStrategy !== undefined || literal !== undefined,
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
			strategy: LooseStrategy,
			literal: string | undefined,
			strategyInput: unknown,
			source: PlannedVersion["source"],
		) => {
			if (group.length === 0) return;
			// A literal is the exact version; no strategy runs, so its input is not read.
			const validated =
				literal === undefined
					? validateInput(
							strategy,
							strategyInput,
							source === "shared"
								? "The plan's input"
								: `${group[0]?.selection.package.name}'s input`,
						)
					: undefined;
			const hasIntent = group.some(
				(entry) =>
					entry.selection.changes.length > 0 ||
					dependenciesOf(entry.selection.package.name).length > 0,
			);
			if (!hasIntent && literal === undefined) {
				for (const entry of group) {
					unchanged.push({
						package: entry.selection.package.name,
						version: entry.previous.id,
						reason: "no-changes",
						previousFrom: entry.previousFrom,
					});
				}
				explanations.push(
					`No changes for ${group.map((entry) => entry.selection.package.name).join(", ")}; nothing to calculate.`,
				);

				return;
			}
			const decoded = group.map((entry) => {
				const ancestry = ancestryOf(strategy, entry.previous, entry.selection.package.name);
				return { entry, previous: ancestry[0], ancestry };
			});
			// A literal is the exact version, decoded by the scheme; no strategy runs.
			const calculation: VersionStrategy.Calculation<unknown, unknown> =
				literal !== undefined
					? { version: decodeWith(strategy, literal, literal), unchanged: "align" }
					: run(strategy, {
							participants: decoded.map(({ entry, previous, ancestry }) => ({
								package: entry.selection.package.name,
								previous,
								ancestry,
								changes: entry.selection.changes,
								dependencies: dependenciesOf(entry.selection.package.name),
							})),
							input: validated,
						});
			const names = new Set(group.map((entry) => entry.selection.package.name));
			const stray = (calculation.versions ?? []).filter((item) => !names.has(item.package));
			if (stray.length > 0) {
				fail(
					"InvalidStrategyResult",
					`${strategy.name} returned versions for packages outside its calculation.`,
					[strategy.name, ...stray.map((item) => item.package)],
				);
			}
			for (const { entry, previous } of decoded) {
				const { selection } = entry;
				const name = selection.package.name;
				const own = calculation.versions?.find((item) => item.package === name);
				const target = own === undefined ? calculation.version : own.version;
				const details =
					own === undefined ? calculation.details : (own.details ?? calculation.details);
				// A literal keeps its spelling; calculated versions are encoded by the scheme.
				const placement = literal ?? strategy.scheme.encode(target);
				const fromDependencies = dependenciesOf(name).length > 0;
				const intent = selection.changes.length > 0 || fromDependencies;
				if (strategy.scheme.order(target, previous) < 0) {
					fail(
						"Downgrade",
						`${placement} would downgrade ${name} from ${entry.previous.id}.`,
						[name],
					);
				}
				if (
					!intent &&
					(calculation.unchanged === "drift" || placement === entry.previous.id)
				) {
					unchanged.push({
						package: name,
						version: entry.previous.id,
						reason: calculation.unchanged === "drift" ? "drift" : "no-changes",
						previousFrom: entry.previousFrom,
					});
					continue;
				}
				// One identity, one definition: a planned id must be new to the whole history.
				if (selection.package.history.versions.some((known) => known.id === placement)) {
					fail(
						"ExistingVersion",
						`${name}@${placement} already exists in its history; new contents need a new version.`,
						[name, placement],
					);
				}
				const version = Version.make(placement, {
					previous: entry.previous,
					changes: [...selection.changes],
				});
				versions.push({
					package: name,
					version,
					details,
					source,
					reason:
						literal !== undefined
							? "target"
							: selection.changes.length > 0
								? "changes"
								: fromDependencies
									? "dependencies"
									: "alignment",
					dependencies: [],
					previousFrom: entry.previousFrom,
				});
			}
		};

		place(
			entries.filter((entry) => !entry.override),
			sharedStrategy,
			sharedLiteral,
			input.input,
			"shared",
		);
		for (const entry of entries) {
			if (entry.override)
				place([entry], entry.strategy, entry.literal, entry.ownInput, "override");
		}
		if (entries.some((entry) => entry.override)) {
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
		if (ignoreAsync(result) || !Array.isArray(result)) {
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
		release: owner,
		versions: calculated.versions.map((planned) => ({
			...planned,
			dependencies: updates.filter((update) => update.dependent === planned.package),
		})),
		unchanged: calculated.unchanged,
		dependents: sorted,
		dependencyUpdates: updates,
		// Copies, so changing the caller's configuration afterwards cannot change this plan.
		replacements: (input.replacements ?? config.replacements ?? []).map((rule) => ({
			files: [...rule.files],
			...(rule.exclude === undefined ? {} : { exclude: [...rule.exclude] }),
			match: rule.match,
			versionOf: rule.versionOf,
		})),
		files: new Map(
			config.packages.map((registration) => [
				registration.package.name,
				{ manifest: registration.files.manifest, versions: registration.files.versions },
			]),
		),
		exportName: config.exportName ?? "version",
		explanations: [
			...entries.flatMap((entry) =>
				entry.previousFrom === "history-head"
					? [
							`${entry.selection.package.name}: no previous stated; using the only head of its history, ${entry.previous.id}.`,
						]
					: [],
			),
			...calculated.explanations,
			// Releasing from a version that already has later versions forks beside them. It is
			// allowed: it may be intended, or come from a stale manifest or a bad merge.
			...calculated.versions.flatMap((planned) => {
				const from = planned.version.previous;
				const pkg = entries.find(
					(entry) => entry.selection.package.name === planned.package,
				)?.selection.package;
				const later =
					from === undefined || pkg === undefined
						? []
						: pkg.history.versions.filter(
								(version) => version.previous?.id === from.id,
							);
				return later.length === 0
					? []
					: [
							`Note: ${planned.package}@${from?.id} already has later versions (${later.map((version) => version.id).join(", ")}); ${planned.version.id} forks beside them. Check the manifest or previous version if this is not intended.`,
						];
			}),
		],
	};
};

const planOrError = (try_: () => Plan): Result.Result<Plan, PlanError> =>
	Result.try({
		try: try_,
		catch: (error) => {
			if (error instanceof PlanError) return error;
			if (error instanceof VersionStrategy.StrategyRefusal) {
				return new PlanError(issue("StrategyRefused", error.message, error.subjects));
			}
			return new PlanError(
				issue(
					"InvalidStrategyResult",
					`Planning failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		},
	});

/**
 * Declares a bounded release group with a stable identifier. Plans can only release its
 * registered packages. Strategies must be pure: the planner may call them several times.
 *
 * @example
 * ```ts
 * const release = Release.make("widgets", {
 * 	packages: [{ package: widgets, files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }) }],
 * 	change: ReleaseChange.define(),
 * 	version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
 * });
 * const plan = release.plan({ packages: [{ package: widgets, changes: [retries] }] });
 * ```
 *
 * @since @next
 */
export const make = <M extends object, V, I, D, const Rs extends ReadonlyArray<Registration<M>>>(
	group: string,
	config: Config<M, V, I, D, Rs>,
): Release<M, V, I, D, Rs> => {
	if (group.trim() === "")
		throw new PlanError(issue("GroupId", "A release group needs a stable identifier."));
	if ("pre" in config || "input" in config) {
		throw new PlanError(
			issue(
				"InvalidPre",
				"Strategy input, such as pre, is a per-plan choice and cannot be configured on a group.",
			),
		);
	}
	if (!VersionStrategy.isVersionStrategy(config.version)) {
		throw new PlanError(
			issue(
				"NotAStrategy",
				"The group's version is not a version strategy. Build strategies with VersionStrategy.make.",
			),
		);
	}
	const names = config.packages.map((registration) => registration.package.name);
	const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
	if (duplicates.length > 0)
		throw new PlanError(issue("DuplicatePackage", "Register each package once.", duplicates));

	// The loose planner checks values the public types already constrain.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const loose = { group, config } as unknown as LooseRelease;
	const release = {
		_tag: "Release" as const,
		group,
		config,
		plan: (input: LooseInput) => planOrError(() => buildPlan(loose, input, owner)),
	};
	// The plan method's generic signature is enforced at the call site.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const owner = release as unknown as Release<M, V, I, D, Rs>;

	return owner;
};

/**
 * Plans once without keeping the group. It takes the same stable group identifier.
 *
 * @since @next
 */
export const plan = <
	M extends object,
	V,
	I,
	D,
	const Rs extends ReadonlyArray<Registration<M>>,
	const Ps extends ReadonlyArray<Entry<Rs>>,
>(
	group: string,
	config: Config<M, V, I, D, Rs>,
	input: Input<M, V, I, D, Rs, Ps>,
): Result.Result<Plan<M, PlanDetails<D, Rs>>, PlanError> =>
	Result.flatMap(
		Result.try({
			try: () => make(group, config),
			catch: (error) => {
				if (error instanceof PlanError) return error;
				throw error;
			},
		}),
		(release) => release.plan<Ps>(input),
	);
