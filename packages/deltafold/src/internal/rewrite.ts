import { Array as Arr, Order } from "effect";

import type * as Action from "../action.ts";
import type * as Migration from "../migration.ts";
import type { Occurrence } from "../plan.ts";
import type * as Rule from "../rule.ts";

/**
 * A top-level element of a route's sequential spine, or of one parallel branch. `step`
 * is the index of the plan step that owns the element.
 */
export type Item =
	| { readonly _tag: "Occ"; readonly occurrence: Occurrence; readonly step: number }
	| {
			readonly _tag: "Par";
			readonly branches: ReadonlyArray<ReadonlyArray<Item>>;
			readonly concurrency: Action.Concurrency;
			readonly step: number;
	  }
	/** A text-only migration: manual work that rules must not match around. */
	| { readonly _tag: "Barrier"; readonly step: number };

export type Application = {
	readonly rule: Rule.Any;
	readonly removed: ReadonlyArray<Occurrence>;
	readonly produced: ReadonlyArray<Occurrence>;
};

export type Outcome = {
	readonly items: ReadonlyArray<Item>;
	readonly trace: ReadonlyArray<Application>;
};

export type Failure =
	| {
			readonly _tag: "RewriteCycle";
			/** Rules applied around the cycle, in order. */
			readonly rules: ReadonlyArray<string>;
			/** The action sequence that repeats. */
			readonly actions: string;
	  }
	| {
			readonly _tag: "ConflictingRewrites";
			readonly outcomes: ReadonlyArray<{
				readonly actions: string;
				readonly rules: ReadonlyArray<string>;
			}>;
	  }
	| {
			readonly _tag: "RewriteLimitExceeded";
			readonly limit: "states" | "depth";
			readonly value: number;
	  };

class RewriteFailure {
	readonly failure: Failure;

	constructor(failure: Failure) {
		this.failure = failure;
	}
}

/** The largest number of distinct states explored while normalizing one sequence. */
export const stateLimit = 10_000;

/** The largest number of rule applications in one chain of rewrites. */
export const depthLimit = 256;

const occurrencesOf = (items: ReadonlyArray<Item>): ReadonlyArray<Occurrence> =>
	items.flatMap((item) => {
		if (item._tag === "Occ") return [item.occurrence];
		if (item._tag === "Par") return item.branches.flatMap(occurrencesOf);

		return [];
	});

export { occurrencesOf };

const groupKey = (branches: ReadonlyArray<string>) =>
	`{${Arr.sort(
		branches.map((branch) => `[${branch}]`),
		Order.String,
	).join("|")}}`;

/** A key that identifies a sequence by its action structure. Branch order is ignored. */
export const keyOf = (items: ReadonlyArray<Item>): string =>
	items
		.map((item) => {
			if (item._tag === "Occ") return JSON.stringify(item.occurrence.action.id);
			if (item._tag === "Barrier") return "#";

			return groupKey(item.branches.map(keyOf));
		})
		.join(",");

const stepKey = (steps: ReadonlyArray<Action.Step>): string =>
	steps
		.map((step) => {
			switch (step._tag) {
				case "Action":
					return JSON.stringify(step.id);
				case "Instruction":
					return JSON.stringify(step.action.id);
				case "Sequence":
					return stepKey(step.children);
			}
			const branches = step.branches.map((branch) => stepKey([branch]));
			if (branches.length === 1) return branches[0];

			return groupKey(branches);
		})
		.filter((key) => key !== "")
		.join(",");

export type MakeOccurrence = (
	action: Action.Any,
	instruction: Migration.Instruction | undefined,
) => Occurrence;

/** Converts declared steps to items. Sequences flatten; single-branch groups flatten. */
export const itemsOf = (
	steps: ReadonlyArray<Action.Step>,
	make: MakeOccurrence,
	step: number,
): ReadonlyArray<Item> =>
	steps.flatMap((declared): ReadonlyArray<Item> => {
		switch (declared._tag) {
			case "Action":
				return [{ _tag: "Occ", occurrence: make(declared, undefined), step }];
			case "Instruction":
				return [{ _tag: "Occ", occurrence: make(declared.action, declared), step }];
			case "Sequence":
				return itemsOf(declared.children, make, step);
		}

		return parallelOf(
			declared.branches.map((branch) => itemsOf([branch], make, step)),
			declared.concurrency,
			step,
		);
	});

/** Drops empty branches and flattens a group that has a single branch left. */
const parallelOf = (
	branches: ReadonlyArray<ReadonlyArray<Item>>,
	concurrency: Action.Concurrency,
	step: number,
): ReadonlyArray<Item> => {
	const nonEmpty = branches.filter((branch) => branch.length > 0);
	if (nonEmpty.length === 0) return [];
	if (nonEmpty.length === 1) return nonEmpty[0] ?? [];

	return [{ _tag: "Par", branches: nonEmpty, concurrency, step }];
};

const matchesAt = (
	pattern: ReadonlyArray<Rule.Pattern>,
	items: ReadonlyArray<Item>,
	position: number,
): boolean =>
	pattern.every((expected, offset) => {
		const item = items[position + offset];
		if (item === undefined) return false;
		if (expected._tag === "Action") {
			return item._tag === "Occ" && item.occurrence.action.id === expected.id;
		}

		return item._tag === "Par" && keyOf([item]) === stepKey([expected]);
	});

type Normalizer = {
	readonly normalize: (items: ReadonlyArray<Item>) => Outcome;
};

const makeNormalizer = (rules: ReadonlyArray<Rule.Any>): Normalizer => {
	const ordered = Arr.sort(
		rules,
		Order.mapInput(Order.String, (rule: Rule.Any) => rule.id),
	);

	/** Normalizes the branches of every group, then flattens groups that collapsed. */
	const normalizeBranches = (items: ReadonlyArray<Item>): Outcome => {
		const trace: Array<Application> = [];
		const result = items.flatMap((item): ReadonlyArray<Item> => {
			if (item._tag !== "Par") return [item];

			const branches = item.branches.map((branch) => {
				const outcome = normalize(branch);
				trace.push(...outcome.trace);

				return outcome.items;
			});

			return parallelOf(branches, item.concurrency, item.step);
		});

		return { items: result, trace };
	};

	const replace = (rule: Rule.Any, items: ReadonlyArray<Item>, position: number) => {
		const matched = items.slice(position, position + rule.match.length);
		const removed = occurrencesOf(matched);
		const first = removed[0];
		// A non-empty match always covers at least one occurrence.
		if (first === undefined) throw new Error(`Rule "${rule.id}" matched no occurrences`);
		const step = matched[0]?.step ?? 0;
		const produced: Array<Occurrence> = [];
		const make: MakeOccurrence = (action, instruction) => {
			const occurrence: Occurrence = {
				_tag: "Occurrence",
				id: `${rule.id}(${removed.map((replaced) => replaced.id).join("+")})/${action.id}`,
				action,
				migration: first.migration,
				direction: first.direction,
				instruction,
				origin: { _tag: "Replacement", rule, replaces: removed },
			};
			produced.push(occurrence);

			return occurrence;
		};
		const replacement = normalizeBranches(itemsOf(rule.replacement, make, step));
		const next = [
			...items.slice(0, position),
			...replacement.items,
			...items.slice(position + rule.match.length),
		];

		return {
			next,
			applications: [{ rule, removed, produced }, ...replacement.trace],
		};
	};

	const normalize = (input: ReadonlyArray<Item>): Outcome => {
		const start = normalizeBranches(input);
		const seen = new Set<string>();
		const onPath = new Map<string, number>();
		const normals = new Map<string, Outcome>();

		const visit = (items: ReadonlyArray<Item>, trace: ReadonlyArray<Application>): void => {
			const key = keyOf(items);
			const entered = onPath.get(key);
			if (entered !== undefined) {
				throw new RewriteFailure({
					_tag: "RewriteCycle",
					rules: trace.slice(entered).map((application) => application.rule.id),
					actions: key,
				});
			}
			if (seen.has(key)) return;

			seen.add(key);
			if (seen.size > stateLimit) {
				throw new RewriteFailure({
					_tag: "RewriteLimitExceeded",
					limit: "states",
					value: stateLimit,
				});
			}
			if (trace.length > depthLimit) {
				throw new RewriteFailure({
					_tag: "RewriteLimitExceeded",
					limit: "depth",
					value: depthLimit,
				});
			}
			onPath.set(key, trace.length);

			let applied = false;
			for (let position = 0; position < items.length; position++) {
				for (const rule of ordered) {
					if (rule.match.length === 0 || !matchesAt(rule.match, items, position))
						continue;

					applied = true;
					const { next, applications } = replace(rule, items, position);
					visit(next, [...trace, ...applications]);
				}
			}
			if (!applied && !normals.has(key)) normals.set(key, { items, trace });

			onPath.delete(key);
		};

		visit(start.items, start.trace);

		if (normals.size > 1) {
			throw new RewriteFailure({
				_tag: "ConflictingRewrites",
				outcomes: [...normals.entries()].map(([actions, outcome]) => ({
					actions,
					rules: outcome.trace.map((application) => application.rule.id),
				})),
			});
		}

		const [outcome] = normals.values();

		return outcome ?? start;
	};

	return { normalize };
};

/** Applies rules to a sequence until no rule matches. */
export const rewrite = (
	items: ReadonlyArray<Item>,
	rules: ReadonlyArray<Rule.Any>,
):
	| { readonly _tag: "Success"; readonly outcome: Outcome }
	| { readonly _tag: "Failure"; readonly failure: Failure } => {
	try {
		return { _tag: "Success", outcome: makeNormalizer(rules).normalize(items) };
	} catch (error) {
		if (error instanceof RewriteFailure) return { _tag: "Failure", failure: error.failure };

		throw error;
	}
};
