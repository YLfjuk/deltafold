import { SemVer } from "effect";

import { form, satisfies } from "./ranges.ts";

/**
 * A dependency between workspace packages, resolved from manifests before planning.
 *
 * @since @next
 */
export type Requirement = {
	readonly dependency: string;
	readonly dependent: string;
	/** The dependency field, such as `dependencies` or `peerDependencies`. */
	readonly field: string;
	readonly range: string;
	/** The dependent's manifest, relative to the working directory. */
	readonly manifest: string;
	/** A private dependent can need a manifest edit without being published. */
	readonly private: boolean;
};

/**
 * What a policy decides for one requirement on a package this plan releases.
 *
 * - `edit`: rewrite the dependent's range.
 * - `release`: the dependent needs a release of its own.
 * - `satisfied`: the new version already satisfies the range; nothing changes.
 * - `workspace`: a `workspace:` range, which the package manager resolves at publish time.
 * - `cross-group`: the dependent is outside this group. It is reported, never added.
 * - `missing-selection`: the dependent needs a release that the plan does not select.
 *
 * @since @next
 */
export type Action =
	| "edit"
	| "release"
	| "satisfied"
	| "workspace"
	| "cross-group"
	| "missing-selection";

/** @since @next */
export type Proposal = Requirement & { readonly action: Action };

/** @since @next */
export type Context = {
	/** Requirements on packages this plan releases. */
	readonly requirements: ReadonlyArray<Requirement>;
	readonly members: ReadonlyArray<string>;
	/** The version each released package receives. */
	readonly versions: ReadonlyMap<string, string>;
};

/**
 * Decides dependent work. It must return synchronously. Planning runs it until no new
 * `release` appears, so a dependent's own dependents are considered too.
 *
 * @since @next
 */
export type Policy = (context: Context) => ReadonlyArray<Proposal>;

/**
 * When a range is rewritten: only when the new version falls outside it (the default), or
 * whenever the dependency is released.
 *
 * @since @next
 */
export type Options = { readonly updateRanges?: "out-of-range" | "always" };

const decide = (
	context: Context,
	options: Options,
	unselected: "release" | "missing-selection",
): ReadonlyArray<Proposal> =>
	context.requirements.flatMap((requirement): ReadonlyArray<Proposal> => {
		if (!context.members.includes(requirement.dependent)) {
			return [{ ...requirement, action: "cross-group" }];
		}
		const range = form(requirement.range);
		if (range._tag === "Workspace") return [{ ...requirement, action: "workspace" }];
		const version = context.versions.get(requirement.dependency);
		const inRange = version !== undefined && satisfies(range, SemVer.parseUnsafe(version));
		if (inRange && (options.updateRanges ?? "out-of-range") === "out-of-range") {
			return [{ ...requirement, action: "satisfied" }];
		}
		const edit: Proposal = { ...requirement, action: "edit" };
		// A dev-only dependency does not change what consumers install.
		if (
			requirement.private ||
			requirement.field === "devDependencies" ||
			context.versions.has(requirement.dependent)
		) {
			return [edit];
		}

		return [edit, { ...requirement, action: unselected }];
	});

/**
 * Includes required work in the plan: range edits for dependents in the group, and
 * releases for public dependents whose range changes. Dependents outside the group are
 * reported as `cross-group`.
 *
 * @since @next
 */
export const propose =
	(options: Options = {}): Policy =>
	(context) =>
		decide(context, options, "release");

/**
 * Like `propose`, but a required release that the plan does not select is reported as
 * `missing-selection`, and preparation refuses until it is selected.
 *
 * @since @next
 */
export const explicit =
	(options: Options = {}): Policy =>
	(context) =>
		decide(context, options, "missing-selection");
