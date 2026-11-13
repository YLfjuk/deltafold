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
	/** A private dependent can need a manifest edit without being published. */
	readonly private: boolean;
};

/**
 * What a policy proposes for one requirement.
 *
 * - `edit`: update the dependent's manifest range.
 * - `release`: the dependent needs a release of its own.
 * - `cross-group`: the dependent is outside this group. It is reported, never added.
 * - `missing-selection`: the dependent is in the group but was not selected.
 *
 * @since @next
 */
export type Proposal = Requirement & {
	readonly action: "edit" | "release" | "cross-group" | "missing-selection";
};

/** @since @next */
export type Context = {
	/** Requirements on packages this plan releases. */
	readonly requirements: ReadonlyArray<Requirement>;
	readonly members: ReadonlyArray<string>;
	readonly released: ReadonlyArray<string>;
};

/**
 * Proposes dependent work. It must return synchronously.
 *
 * @since @next
 */
export type Policy = (context: Context) => ReadonlyArray<Proposal>;

/**
 * Proposes manifest edits for every dependent in the group, and releases for public
 * dependents. Dependents outside the group are reported as `cross-group`.
 *
 * @since @next
 */
export const propose = (): Policy => (context) =>
	context.requirements.flatMap((requirement): ReadonlyArray<Proposal> => {
		if (!context.members.includes(requirement.dependent))
			return [{ ...requirement, action: "cross-group" }];
		const edit: Proposal = { ...requirement, action: "edit" };
		if (requirement.private || context.released.includes(requirement.dependent)) return [edit];

		return [edit, { ...requirement, action: "release" }];
	});

/**
 * Proposes nothing beyond what the input selected. Public dependents in the group that
 * the plan does not release are reported as `missing-selection`.
 *
 * @since @next
 */
export const explicit = (): Policy => (context) =>
	context.requirements.map((requirement): Proposal => {
		if (!context.members.includes(requirement.dependent))
			return { ...requirement, action: "cross-group" };
		if (requirement.private || context.released.includes(requirement.dependent))
			return { ...requirement, action: "edit" };

		return { ...requirement, action: "missing-selection" };
	});
