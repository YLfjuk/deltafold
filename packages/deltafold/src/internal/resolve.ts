import { Array as Arr, Graph, Order, Result, SemVer } from "effect";

import type * as Action from "../action.ts";
import type { Change } from "../change.ts";
import type * as Migration from "../migration.ts";
import type {
	Direction,
	Explanation,
	Hop,
	Node,
	Plan,
	RequestDirection,
	Route,
	Step,
} from "../plan.ts";
import {
	AmbiguousRoute,
	ConflictingRewrites,
	RewriteCycle,
	RewriteLimitExceeded,
	TooManyRoutes,
	UnknownRoute,
	UnknownVersion,
	UnsupportedRoute,
	type Blocker,
	type ResolveError,
	type RewriteError,
	type RouteSummary,
} from "../resolve-error.ts";
import type * as Shortcut from "../shortcut.ts";
import type { Version } from "../version.ts";
import { resolveGuide } from "./guide.ts";
import { itemsOf, occurrencesOf, rewrite, type Item, type MakeOccurrence } from "./rewrite.ts";
import { actionsOfSteps, hasProse, hopsOf, stepsOf, type Declarations } from "./validate.ts";

/**
 * Route policies for choosing between candidate routes. Each one is opt-in.
 *
 * @since @next
 */
export type RoutePolicy =
	| "fewest-actions"
	| "fewest-migrations"
	| "lowest-cost"
	| "prefer-shortcuts";

/** The largest number of candidate routes enumerated between two versions. */
export const routeLimit = 100;

type Member = { readonly migration: Migration.Any; readonly direction: Direction };

type Edge = {
	readonly from: Version;
	readonly to: Version;
	readonly members: ReadonlyArray<Member>;
	readonly shortcut: Shortcut.Any | undefined;
	readonly cost: number;
	readonly class: "up" | "down" | "cross";
};

type Candidate = {
	readonly route: Route;
	readonly edges: ReadonlyArray<Edge>;
	readonly plan: Result.Result<Plan, RewriteError>;
	readonly cost: number;
};

export type Context = {
	readonly declarations: Declarations;
	readonly versions: ReadonlyMap<string, Version>;
	/** Strict ancestors of each version, by identifier. */
	readonly ancestors: ReadonlyMap<string, ReadonlySet<string>>;
	readonly edges: ReadonlyArray<Edge>;
	/** Reasons a reverse edge is missing, keyed by `from>to`. */
	readonly reverseBlockers: ReadonlyMap<string, string>;
};

const pairKey = (from: string, to: string) => `${JSON.stringify(from)}>${JSON.stringify(to)}`;

const memberCost = (migration: Migration.Any) => migration.cost ?? 1;

export const makeContext = (declarations: Declarations): Context => {
	const versions = new Map(declarations.versions.map((version) => [version.id, version]));
	const ancestors = new Map<string, ReadonlySet<string>>();
	const ancestorsOf = (id: string): ReadonlySet<string> => {
		const known = ancestors.get(id);
		if (known !== undefined) return known;

		const result = new Set<string>();
		let current = versions.get(id)?.previous;
		while (current !== undefined && !result.has(current.id)) {
			result.add(current.id);
			current = versions.get(current.id)?.previous;
		}
		ancestors.set(id, result);

		return result;
	};
	for (const id of versions.keys()) ancestorsOf(id);

	const classOf = (from: string, to: string): Edge["class"] => {
		if (ancestorsOf(to).has(from)) return "up";
		if (ancestorsOf(from).has(to)) return "down";

		return "cross";
	};

	// Migrations with the same endpoints are complementary: they form one edge and all run.
	const groups = new Map<string, { from: Version; to: Version; members: Array<Member> }>();
	const reverseCandidates = new Map<
		string,
		{ reversible: Array<Member>; missing: Array<string> }
	>();
	const groupOf = (from: Version, to: Version) => {
		const key = pairKey(from.id, to.id);
		const existing = groups.get(key);
		if (existing !== undefined) return existing;

		const created = { from, to, members: [] };
		groups.set(key, created);

		return created;
	};
	for (const migration of declarations.migrations) {
		groupOf(migration.from, migration.to).members.push({ migration, direction: "forward" });

		const key = pairKey(migration.to.id, migration.from.id);
		const reverse = reverseCandidates.get(key) ?? { reversible: [], missing: [] };
		if (migration.revert === undefined) reverse.missing.push(migration.id);
		else reverse.reversible.push({ migration, direction: "revert" });
		reverseCandidates.set(key, reverse);
	}

	// A reverse edge exists only when every migration of the forward group can be reverted.
	const reverseBlockers = new Map<string, string>();
	for (const migration of declarations.migrations) {
		const key = pairKey(migration.to.id, migration.from.id);
		const reverse = reverseCandidates.get(key);
		if (reverse === undefined || reverse.reversible.length === 0) continue;
		if (reverse.missing.length > 0) {
			reverseBlockers.set(
				key,
				`Migrations ${reverse.missing.map((id) => `"${id}"`).join(", ")} have no revert, so the reverse transition is incomplete.`,
			);
			reverseCandidates.delete(key);
			continue;
		}
		const group = groupOf(migration.to, migration.from);
		for (const member of reverse.reversible) {
			if (!group.members.includes(member)) group.members.push(member);
		}
		reverseCandidates.delete(key);
	}

	const edges: Array<Edge> = [...groups.values()].map((group) => ({
		from: group.from,
		to: group.to,
		members: group.members,
		shortcut: undefined,
		cost: group.members.reduce((total, member) => total + memberCost(member.migration), 0),
		class: classOf(group.from.id, group.to.id),
	}));
	for (const shortcut of declarations.shortcuts) {
		edges.push({
			from: shortcut.from,
			to: shortcut.to,
			members: shortcut.migrations.map((migration) => ({ migration, direction: "forward" })),
			shortcut,
			cost:
				shortcut.cost ??
				shortcut.migrations.reduce((total, migration) => total + memberCost(migration), 0),
			class: classOf(shortcut.from.id, shortcut.to.id),
		});
	}

	return { declarations, versions, ancestors, edges, reverseBlockers };
};

const requestDirection = (context: Context, from: string, to: string): RequestDirection => {
	if (from === to) return "none";
	if (context.ancestors.get(to)?.has(from)) return "upgrade";
	if (context.ancestors.get(from)?.has(to)) return "downgrade";

	return "cross-branch";
};

/**
 * Edge classes allowed together in one route. A route never mixes moves toward
 * ancestors with moves toward descendants, so sharing an ancestor does not authorize a
 * downgrade-and-upgrade detour. Explicit cross-branch migrations fit either family.
 */
const families: ReadonlyArray<ReadonlySet<Edge["class"]>> = [
	new Set(["up", "cross"]),
	new Set(["down", "cross"]),
];

const routeOf = (from: Version, edges: ReadonlyArray<Edge>): Route => {
	let id = from.id;
	const hops: Array<Hop> = [];
	for (const edge of edges) {
		if (edge.shortcut === undefined) {
			id += `>${edge.to.id}`;
			hops.push({
				_tag: "Migrations",
				from: edge.from,
				to: edge.to,
				migrations: edge.members,
			});
			continue;
		}
		id += `>[${edge.shortcut.id}]>${edge.to.id}`;
		hops.push({ _tag: "Shortcut", from: edge.from, to: edge.to, shortcut: edge.shortcut });
	}

	return { id, hops };
};

const graphOf = (context: Context, family: ReadonlySet<Edge["class"]>) => {
	const nodes = new Map<string, Graph.NodeIndex>();
	const graph = Graph.directed<string, Edge>((mutable) => {
		for (const id of context.versions.keys()) nodes.set(id, Graph.addNode(mutable, id));
		for (const edge of context.edges) {
			if (!family.has(edge.class)) continue;

			const source = nodes.get(edge.from.id);
			const target = nodes.get(edge.to.id);
			if (source !== undefined && target !== undefined)
				Graph.addEdge(mutable, source, target, edge);
		}
	});

	return { graph, nodes };
};

const enumerateRoutes = (
	context: Context,
	from: Version,
	to: Version,
): Result.Result<ReadonlyArray<ReadonlyArray<Edge>>, TooManyRoutes> => {
	const routes = new Map<string, ReadonlyArray<Edge>>();
	for (const family of families) {
		const { graph, nodes } = graphOf(context, family);
		const source = nodes.get(from.id);
		const target = nodes.get(to.id);
		if (source === undefined || target === undefined) continue;

		for (const path of Graph.simplePaths(graph, { source, target, limit: routeLimit + 1 })) {
			routes.set(routeOf(from, path.costs).id, path.costs);
		}
	}
	if (routes.size > routeLimit) {
		return Result.fail(new TooManyRoutes({ from: from.id, to: to.id, limit: routeLimit }));
	}

	return Result.succeed([...routes.values()]);
};

const declaredOccurrenceId = (migration: Migration.Any, direction: Direction, action: Action.Any) =>
	direction === "forward"
		? `${migration.id}/${action.id}`
		: `${migration.id}/revert/${action.id}`;

const toNode = (items: ReadonlyArray<Item>): ReadonlyArray<Node> =>
	items.flatMap((item): ReadonlyArray<Node> => {
		if (item._tag === "Occ") return [item.occurrence];
		if (item._tag === "Barrier") return [];

		return [
			{
				_tag: "Parallel",
				branches: item.branches.map((branch) => {
					const children = toNode(branch);
					const [only] = children;

					return children.length === 1 && only !== undefined
						? only
						: { _tag: "Sequence", children };
				}),
				concurrency: item.concurrency,
			},
		];
	});

const contentOf = (member: Member): Migration.Content =>
	(member.direction === "forward" ? member.migration.content : member.migration.revert) ?? [];

const buildPlan = (
	context: Context,
	from: Version,
	to: Version,
	direction: RequestDirection,
	edges: ReadonlyArray<Edge>,
): Result.Result<Plan, RewriteError> => {
	const route = routeOf(from, edges);
	const members = edges.flatMap((edge) => edge.members);

	const items = members.flatMap((member, index): ReadonlyArray<Item> => {
		const content = contentOf(member);
		const make: MakeOccurrence = (action, instruction) => ({
			_tag: "Occurrence",
			id: declaredOccurrenceId(member.migration, member.direction, action),
			action,
			migration: member.migration,
			direction: member.direction,
			instruction,
			origin: { _tag: "Declared" },
		});
		const declared = itemsOf(stepsOf(content), make, index);
		if (declared.length === 0 && hasProse(content)) return [{ _tag: "Barrier", step: index }];

		return declared;
	});

	const rewritten = rewrite(items, context.declarations.rules);
	if (rewritten._tag === "Failure") {
		const failure = rewritten.failure;
		switch (failure._tag) {
			case "RewriteCycle":
				return Result.fail(
					new RewriteCycle({
						route: route.id,
						rules: failure.rules,
						actions: failure.actions,
					}),
				);
			case "ConflictingRewrites":
				return Result.fail(
					new ConflictingRewrites({ route: route.id, outcomes: failure.outcomes }),
				);
		}

		return Result.fail(
			new RewriteLimitExceeded({
				route: route.id,
				limit: failure.limit,
				value: failure.value,
			}),
		);
	}
	const { items: optimized, trace } = rewritten.outcome;

	const explanations: Array<Explanation> = trace.map((application) => ({
		_tag: "Rewrite",
		rule: application.rule,
		removed: application.removed,
		produced: application.produced,
	}));

	const steps = members.map((member, index): Step => {
		const stepItems = optimized.filter((item) => item.step === index);
		const content = contentOf(member);
		const declaredCount = actionsOfSteps(stepsOf(content)).length;
		const retained = occurrencesOf(stepItems);
		const guide = resolveGuide(content, retained, (action) =>
			declaredOccurrenceId(member.migration, member.direction, action),
		);
		const allRemoved = declaredCount > 0 && retained.length === 0;
		const omitted = member.migration.noop || allRemoved;
		if (omitted) {
			explanations.push({
				_tag: "OmittedStep",
				migration: member.migration,
				direction: member.direction,
				reason: member.migration.noop ? "noop" : "all-actions-removed",
			});
		}
		const [stepFrom, stepTo] =
			member.direction === "forward"
				? [member.migration.from, member.migration.to]
				: [member.migration.to, member.migration.from];

		return {
			_tag: "Step",
			migration: member.migration,
			direction: member.direction,
			from: stepFrom,
			to: stepTo,
			node: { _tag: "Sequence", children: toNode(stepItems) },
			guide: omitted ? [] : guide,
			omitted,
		};
	});

	const changes: Array<Change> = [];
	for (const member of members) {
		for (const change of member.migration.addresses) {
			if (!changes.some((known) => known.id === change.id)) changes.push(change);
		}
	}

	return Result.succeed({
		_tag: "Plan",
		from,
		to,
		direction,
		route,
		steps,
		occurrences: occurrencesOf(optimized),
		changes,
		explanations,
		coverage: "static",
	});
};

const summaryOf = (candidate: Candidate): RouteSummary => ({
	id: candidate.route.id,
	migrations: candidate.edges.flatMap((edge) =>
		edge.members.map((member) => member.migration.id),
	),
	shortcuts: candidate.edges.flatMap((edge) =>
		edge.shortcut === undefined ? [] : [edge.shortcut.id],
	),
	actions: Result.isSuccess(candidate.plan)
		? candidate.plan.success.occurrences.length
		: undefined,
	cost: candidate.cost,
	failure: Result.isFailure(candidate.plan) ? candidate.plan.failure.message : undefined,
});

/** Tokens of one hop. Complementary migrations run as a unit, so their order is ignored. */
const hopTokens = (members: ReadonlyArray<Member>) =>
	Arr.sort(
		members.map((member) => `${member.direction}:${member.migration.id}`),
		Order.String,
	);

/** Migration tokens of a route, with shortcut hops expanded to the route they replace. */
const canonicalTokens = (candidate: Candidate) =>
	candidate.edges
		.flatMap((edge) =>
			edge.shortcut === undefined
				? hopTokens(edge.members)
				: hopsOf(edge.shortcut.replaces).flatMap((hop) =>
						hopTokens(hop.map((migration) => ({ migration, direction: "forward" }))),
					),
		)
		.join(",");

const shortcutCount = (candidate: Candidate) =>
	candidate.edges.filter((edge) => edge.shortcut !== undefined).length;

const minimal = (
	candidates: ReadonlyArray<Candidate>,
	measure: (candidate: Candidate) => number | undefined,
): ReadonlyArray<Candidate> => {
	const measured = candidates.flatMap((candidate) => {
		const value = measure(candidate);

		return value === undefined ? [] : [{ candidate, value }];
	});
	const best = Math.min(...measured.map((entry) => entry.value));

	return measured.filter((entry) => entry.value === best).map((entry) => entry.candidate);
};

const applyPolicy = (
	policy: RoutePolicy,
	candidates: ReadonlyArray<Candidate>,
): ReadonlyArray<Candidate> => {
	switch (policy) {
		case "fewest-actions":
			return minimal(candidates, (candidate) =>
				Result.isSuccess(candidate.plan)
					? candidate.plan.success.occurrences.length
					: undefined,
			);
		case "fewest-migrations":
			return minimal(candidates, (candidate) =>
				candidate.edges.reduce((total, edge) => total + edge.members.length, 0),
			);
		case "lowest-cost":
			return minimal(candidates, (candidate) => candidate.cost);
	}

	// prefer-shortcuts: drop a route when another candidate is the same canonical route
	// with more of it replaced by shortcuts. Unrelated routes stay ambiguous.
	return candidates.filter(
		(candidate) =>
			!candidates.some(
				(other) =>
					other !== candidate &&
					canonicalTokens(other) === canonicalTokens(candidate) &&
					shortcutCount(other) > shortcutCount(candidate),
			),
	);
};

const depthOf = (context: Context, id: string) => context.ancestors.get(id)?.size ?? 0;

/** Distance between two versions in the release ancestry tree. */
const ancestryDistance = (context: Context, self: string, that: string): number => {
	const selfLine = [self, ...ancestorsInOrder(context, self)];
	const thatLine = new Set([that, ...ancestorsInOrder(context, that)]);
	const common = selfLine.find((id) => thatLine.has(id));
	if (common === undefined) return Number.POSITIVE_INFINITY;

	return depthOf(context, self) + depthOf(context, that) - 2 * depthOf(context, common);
};

const ancestorsInOrder = (context: Context, id: string): ReadonlyArray<string> => {
	const result: Array<string> = [];
	let current = context.versions.get(id)?.previous;
	while (current !== undefined && !result.includes(current.id)) {
		result.push(current.id);
		current = context.versions.get(current.id)?.previous;
	}

	return result;
};

/** The ancestry path between two versions, through their closest common ancestor. */
const ancestryPath = (context: Context, from: string, to: string): ReadonlyArray<string> => {
	const fromLine = [from, ...ancestorsInOrder(context, from)];
	const toLine = [to, ...ancestorsInOrder(context, to)];
	const common = fromLine.find((id) => toLine.includes(id));
	if (common === undefined) return [];

	return [
		...fromLine.slice(0, fromLine.indexOf(common) + 1),
		...Arr.reverse(toLine.slice(0, toLine.indexOf(common))),
	];
};

export const reachable = (
	context: Context,
	from: string,
	family: ReadonlySet<Edge["class"]>,
): ReadonlyArray<string> => {
	const seen = new Set([from]);
	const queue = [from];
	for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
		for (const edge of context.edges) {
			if (edge.from.id !== current || !family.has(edge.class) || seen.has(edge.to.id))
				continue;

			seen.add(edge.to.id);
			queue.push(edge.to.id);
		}
	}
	seen.delete(from);

	return [...seen];
};

const familiesFor = (direction: RequestDirection) => {
	if (direction === "upgrade") return [families[0]];
	if (direction === "downgrade") return [families[1]];

	return families;
};

const unsupported = (context: Context, from: string, to: string, direction: RequestDirection) => {
	const allowed = familiesFor(direction).flatMap((family) =>
		family === undefined ? [] : [family],
	);
	const reachableIds = Arr.sort(
		new Set(allowed.flatMap((family) => reachable(context, from, family))),
		Order.String,
	);
	const distances = reachableIds.map((id) => ({
		id,
		distance: ancestryDistance(context, id, to),
	}));
	const best = Math.min(...distances.map((entry) => entry.distance));
	const closest = Number.isFinite(best)
		? distances.filter((entry) => entry.distance === best).map((entry) => entry.id)
		: [];

	const path = ancestryPath(context, from, to);
	const blockers: Array<Blocker> = [];
	for (let index = 0; index + 1 < path.length; index++) {
		const hopFrom = path[index];
		const hopTo = path[index + 1];
		if (hopFrom === undefined || hopTo === undefined) continue;
		if (context.edges.some((edge) => edge.from.id === hopFrom && edge.to.id === hopTo))
			continue;

		blockers.push({
			from: hopFrom,
			to: hopTo,
			reason:
				context.reverseBlockers.get(pairKey(hopFrom, hopTo)) ??
				`No migration is declared from "${hopFrom}" to "${hopTo}".`,
		});
	}

	// The common ancestor where an ancestry path turns from moving down to moving up.
	const turn = path.find(
		(id) =>
			context.ancestors.get(from)?.has(id) === true &&
			context.ancestors.get(to)?.has(id) === true,
	);
	if (blockers.length === 0 && turn !== undefined) {
		blockers.push({
			from,
			to,
			reason: `A route through "${turn}" would combine a downgrade with an upgrade. Declare a migration from "${from}" to "${to}".`,
		});
	}

	return new UnsupportedRoute({
		from,
		to,
		direction,
		reachable: reachableIds,
		closest,
		blockers,
	});
};

/** @since @next */
export type ResolveOptions = {
	readonly from: Version | string;
	readonly to: Version | string;
	/** Selects a candidate route by identifier. */
	readonly route?: string;
	/** Chooses between candidate routes. Ties still fail as ambiguous. */
	readonly policy?: RoutePolicy;
};

export const lookup = (context: Context, reference: Version | string) => {
	const id = typeof reference === "string" ? reference : reference.id;
	const version = context.versions.get(id);

	return version === undefined
		? Result.fail(new UnknownVersion({ version: id, known: [...context.versions.keys()] }))
		: Result.succeed(version);
};

export const candidatesBetween = (
	context: Context,
	from: Version,
	to: Version,
): Result.Result<ReadonlyArray<Candidate>, TooManyRoutes> => {
	const direction = requestDirection(context, from.id, to.id);

	return Result.map(enumerateRoutes(context, from, to), (routes) =>
		routes.map((edges) => ({
			route: routeOf(from, edges),
			edges,
			plan: buildPlan(context, from, to, direction, edges),
			cost: edges.reduce((total, edge) => total + edge.cost, 0),
		})),
	);
};

export const resolve = (
	context: Context,
	options: ResolveOptions,
): Result.Result<Plan, ResolveError> =>
	Result.gen(function* () {
		const from = yield* lookup(context, options.from);
		const to = yield* lookup(context, options.to);
		const direction = requestDirection(context, from.id, to.id);
		if (direction === "none") {
			return yield* buildPlan(context, from, to, direction, []);
		}

		const candidates = yield* candidatesBetween(context, from, to);
		if (candidates.length === 0)
			return yield* Result.fail(unsupported(context, from.id, to.id, direction));

		if (options.route !== undefined) {
			const selected = candidates.find((candidate) => candidate.route.id === options.route);
			if (selected === undefined) {
				return yield* Result.fail(
					new UnknownRoute({
						route: options.route,
						candidates: candidates.map(summaryOf),
					}),
				);
			}

			return yield* selected.plan;
		}

		const chosen =
			options.policy === undefined ? candidates : applyPolicy(options.policy, candidates);
		const [only] = chosen;
		if (chosen.length === 1 && only !== undefined) return yield* only.plan;

		return yield* Result.fail(
			new AmbiguousRoute({
				from: from.id,
				to: to.id,
				candidates: (chosen.length === 0 ? candidates : chosen).map(summaryOf),
				policy: options.policy,
			}),
		);
	});

/**
 * A reachable destination and the identifiers of its candidate routes.
 *
 * @since @next
 */
export type Destination = {
	readonly version: Version;
	readonly routes: ReadonlyArray<string>;
};

const semverOrder = (self: string, that: string): number | undefined => {
	const parsedSelf = SemVer.parse(self);
	const parsedThat = SemVer.parse(that);
	if (Result.isFailure(parsedSelf) || Result.isFailure(parsedThat)) return undefined;

	return SemVer.Order(parsedSelf.success, parsedThat.success);
};

/**
 * Destinations reachable from a version. Cross-branch destinations are classified by
 * semver order when both identifiers parse, and listed in both directions otherwise.
 * Classification is presentation only; it does not change routing.
 */
export const destinations = (
	context: Context,
	from: Version,
	kind: "upgrade" | "downgrade",
): ReadonlyArray<Destination> => {
	const family = kind === "upgrade" ? families[0] : families[1];
	if (family === undefined) return [];

	return reachable(context, from.id, family).flatMap((id) => {
		const version = context.versions.get(id);
		if (version === undefined) return [];

		const direction = requestDirection(context, from.id, id);
		if (direction === "cross-branch") {
			const order = semverOrder(id, from.id);
			if (order !== undefined && (kind === "upgrade" ? order < 0 : order > 0)) return [];
		} else if (direction !== kind) {
			return [];
		}

		const routes = Result.getOrElse(candidatesBetween(context, from, version), () => []);

		return [{ version, routes: routes.map((candidate) => candidate.route.id) }];
	});
};
