import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { Action, Change, History, Migration, Plan, Rule, Shortcut, Version } from "deltafold";
import {
	AddKey,
	RenameKey,
	addRetryLimit,
	renameTimeout,
	restoreTimeout,
	retriesAdded,
	securityFixed,
	timeoutRenamed,
	timeoutRestored,
} from "./__fixtures__/config.ts";

const success = <A, E>(result: Result.Result<A, E>): A => {
	if (Result.isFailure(result))
		throw new Error(`Expected success, got ${String(result.failure)}`);

	return result.success;
};

const failure = <A, E>(result: Result.Result<A, E>): E => {
	if (Result.isSuccess(result)) throw new Error("Expected failure");

	return result.failure;
};

const actionIds = (plan: Plan.Any) => plan.occurrences.map((occurrence) => occurrence.action.id);

const rename = (from: string, to: string) =>
	RenameKey.make(`rename-${from}-${to}`, { target: "config", from, to });

const addingMigration = (id: string, from: Version.Version, to: Version.Version) =>
	Migration.make(id, { from, to })`${AddKey.make(`add-${id}`, { target: "config", key: id })}`;

const v0 = Version.make("0.0.0", { changes: [] });
const v100 = Version.make("1.0.0", { previous: v0, changes: [] });
const v152 = Version.make("1.5.2", { previous: v100, changes: [] });
const v200 = Version.make("2.0.0", { previous: v152, changes: [timeoutRenamed] });
const v153 = Version.make("1.5.3", { previous: v152, changes: [securityFixed] });

describe("scenario 1: baseline and explicit empty transitions", () => {
	const initial = Migration.noop("0.0.0-to-1.0.0", { from: v0, to: v100 });
	const patch = Migration.noop("1.0.0-to-1.5.2", { from: v100, to: v152 });
	const major = Migration.make("1.5.2-to-2.0.0", {
		from: v152,
		to: v200,
		addresses: [timeoutRenamed],
	})`
		Update the configuration:

		${renameTimeout}
	`;
	const history = History.make({
		versions: [v0, v100, v152, v200],
		migrations: [initial, patch, major],
	});

	it("composes noops and executable migrations from 0.0.0 to the latest version", () => {
		const plan = success(History.resolve(history, { from: "0.0.0", to: "2.0.0" }));

		expect(plan.route.id).toBe("0.0.0>1.0.0>1.5.2>2.0.0");
		expect(actionIds(plan)).toEqual(["rename-timeout"]);
		expect(plan.changes.map((change) => change.id)).toEqual([timeoutRenamed.id]);
		expect(plan.steps.map((step) => step.omitted)).toEqual([true, true, false]);
	});

	it("returns a valid empty plan for a route made only of noops", () => {
		const plan = success(History.resolve(history, { from: v0, to: v152 }));

		expect(Plan.isEmpty(plan)).toBe(true);
		expect(plan.route.id).toBe("0.0.0>1.0.0>1.5.2");
		expect(plan.explanations).toEqual([
			{ _tag: "OmittedStep", migration: initial, direction: "forward", reason: "noop" },
			{ _tag: "OmittedStep", migration: patch, direction: "forward", reason: "noop" },
		]);
	});

	it("distinguishes an absent route from an empty plan", () => {
		const error = failure(History.resolve(history, { from: "2.0.0", to: "0.0.0" }));

		expect(error._tag).toBe("UnsupportedRoute");
	});

	it("resolves a version to itself as an empty plan", () => {
		const plan = success(History.resolve(history, { from: "1.5.2", to: "1.5.2" }));

		expect(plan.direction).toBe("none");
		expect(plan.steps).toEqual([]);
	});

	it("fails for unknown versions", () => {
		const error = failure(History.resolve(history, { from: "9.9.9", to: "2.0.0" }));

		expect(error).toMatchObject({ _tag: "UnknownVersion", version: "9.9.9" });
	});
});

describe("scenario 2: branching ancestry", () => {
	const migrate152To200 = Migration.make("1.5.2-to-2.0.0", {
		from: v152,
		to: v200,
		addresses: [timeoutRenamed],
	})`${renameTimeout}`;
	const patch = Migration.noop("1.5.2-to-1.5.3", {
		from: v152,
		to: v153,
		addresses: [securityFixed],
	});

	it("does not route a backport through its shared ancestor", () => {
		const history = History.make({
			versions: [v0, v100, v152, v200, v153],
			migrations: [migrate152To200, Migration.withRevert(patch)``],
		});
		const error = failure(History.resolve(history, { from: "1.5.3", to: "2.0.0" }));

		expect(error).toMatchObject({
			_tag: "UnsupportedRoute",
			direction: "cross-branch",
			reachable: ["1.5.2"],
			closest: ["1.5.2"],
			blockers: [
				{
					from: "1.5.3",
					to: "2.0.0",
					reason: 'A route through "1.5.2" would combine a downgrade with an upgrade. Declare a migration from "1.5.3" to "2.0.0".',
				},
			],
		});
	});

	it("migrates the backport only through declared support", () => {
		const migrate153To200 = Migration.make("1.5.3-to-2.0.0", {
			from: v153,
			to: v200,
			addresses: [timeoutRenamed],
		})`${renameTimeout}`;
		const history = History.make({
			versions: [v0, v100, v152, v200, v153],
			migrations: [migrate152To200, patch, migrate153To200],
		});
		const plan = success(History.resolve(history, { from: "1.5.3", to: "2.0.0" }));

		expect(plan.direction).toBe("cross-branch");
		expect(plan.route.id).toBe("1.5.3>2.0.0");
		expect(v153.previous).toBe(v152);
		expect(plan.occurrences.map((occurrence) => occurrence.id)).toEqual([
			"1.5.3-to-2.0.0/rename-timeout",
		]);
	});
});

describe("scenario 3: one migration per transition and alternative routes", () => {
	const v1 = Version.make("1.0.0", { changes: [] });
	const v2 = Version.make("2.0.0", { previous: v1, changes: [timeoutRenamed] });
	const v3 = Version.make("3.0.0", { previous: v2, changes: [retriesAdded] });
	const renameJson = RenameKey.make("rename-json", { target: "config.json", from: "a", to: "b" });
	const renameYaml = RenameKey.make("rename-yaml", { target: "config.yaml", from: "a", to: "b" });
	const config = Migration.make("config-1-to-2", { from: v1, to: v2 })`
		${Migration.instruction(renameJson)`Rename the key in config.json.`}
		${Migration.instruction(renameYaml)`Rename the key in config.yaml.`}
	`;
	const retries = Migration.make("2-to-3", { from: v2, to: v3 })`${addRetryLimit}`;
	const addJsonRetries = AddKey.make("direct-json", { target: "config.json", key: "retries" });
	const direct = Migration.make("1-to-3", { from: v1, to: v3, cost: 1 })`
		${renameJson}
		${renameYaml}
		${addJsonRetries}
	`;

	it("rejects several migrations between the same two versions", () => {
		const json = Migration.make("json-1-to-2", { from: v1, to: v2 })`${renameJson}`;
		const yaml = Migration.make("yaml-1-to-2", { from: v1, to: v2 })`${renameYaml}`;
		const split = History.make({ versions: [v1, v2, v3], migrations: [json, yaml, retries] });

		expect(History.validate(split)).toEqual([
			{
				_tag: "DuplicateEdge",
				subject: "1.0.0 -> 2.0.0",
				message:
					'"json-1-to-2" and "yaml-1-to-2" both go from "1.0.0" to "2.0.0". Merge them into one migration.',
			},
		]);
	});

	it("runs every action of the transition's migration", () => {
		const history = History.make({ versions: [v1, v2, v3], migrations: [config, retries] });
		const plan = success(History.resolve(history, { from: "1.0.0", to: "3.0.0" }));

		expect(plan.route.id).toBe("1.0.0>2.0.0>3.0.0");
		expect(actionIds(plan)).toEqual(["rename-json", "rename-yaml", "add-retry-limit"]);
	});

	const history = History.make({
		versions: [v1, v2, v3],
		migrations: [config, retries, direct],
	});

	it("reports alternative routes as ambiguous with selectable identifiers", () => {
		const error = failure(History.resolve(history, { from: "1.0.0", to: "3.0.0" }));

		expect(error._tag).toBe("AmbiguousRoute");
		if (error._tag !== "AmbiguousRoute") return;
		expect(
			error.candidates.map((candidate) => [candidate.id, candidate.actions, candidate.cost]),
		).toEqual([
			["1.0.0>2.0.0>3.0.0", 3, 2],
			["1.0.0>3.0.0", 3, 1],
		]);
		expect(error.message).toContain("`route` option");
	});

	it("selects a route explicitly", () => {
		const plan = success(
			History.resolve(history, { from: "1.0.0", to: "3.0.0", route: "1.0.0>3.0.0" }),
		);

		expect(plan.steps.map((step) => step.migration.id)).toEqual(["1-to-3"]);
	});

	it("rejects an unknown route identifier and lists the candidates", () => {
		const error = failure(
			History.resolve(history, { from: "1.0.0", to: "3.0.0", route: "1.0.0>9.0.0" }),
		);

		expect(error).toMatchObject({ _tag: "UnknownRoute", route: "1.0.0>9.0.0" });
	});

	it("applies opt-in route policies and keeps ties ambiguous", () => {
		const fewestMigrations = success(
			History.resolve(history, { from: "1.0.0", to: "3.0.0", policy: "fewest-migrations" }),
		);
		const lowestCost = success(
			History.resolve(history, { from: "1.0.0", to: "3.0.0", policy: "lowest-cost" }),
		);
		const tie = failure(
			History.resolve(history, { from: "1.0.0", to: "3.0.0", policy: "fewest-actions" }),
		);

		expect(fewestMigrations.route.id).toBe("1.0.0>3.0.0");
		expect(lowestCost.route.id).toBe("1.0.0>3.0.0");
		expect(tie).toMatchObject({ _tag: "AmbiguousRoute", policy: "fewest-actions" });
	});
});

describe("scenario 4: cancellation across versions", () => {
	const v1 = Version.make("1.0.0", { changes: [] });
	const v2 = Version.make("2.0.0", { previous: v1, changes: [timeoutRenamed] });
	const v3 = Version.make("3.0.0", { previous: v2, changes: [timeoutRestored] });
	const cancelRoundTrip = Rule.replace("cancel-timeout-round-trip", {
		match: [renameTimeout, restoreTimeout],
		replacement: [],
	});
	const forward = Migration.make("1-to-2", { from: v1, to: v2, addresses: [timeoutRenamed] })`
		${Migration.instruction(renameTimeout)`Rename the timeout option, keeping its value.`}
	`;
	const backward = Migration.make("2-to-3", { from: v2, to: v3, addresses: [timeoutRestored] })`
		${Migration.instruction(restoreTimeout)`Restore the timeout option.`}
	`;
	const history = History.make({
		versions: [v1, v2, v3],
		migrations: [forward, backward],
		rules: [cancelRoundTrip],
	});

	it("cancels inverse actions and explains the omission", () => {
		const plan = success(History.resolve(history, { from: "1.0.0", to: "3.0.0" }));

		expect(Plan.isEmpty(plan)).toBe(true);
		expect(plan.steps.every((step) => step.omitted)).toBe(true);
		const [rewrite] = plan.explanations;
		expect(rewrite).toMatchObject({ _tag: "Rewrite", rule: cancelRoundTrip, produced: [] });
		expect(
			rewrite?._tag === "Rewrite" && rewrite.removed.map((occurrence) => occurrence.id),
		).toEqual(["1-to-2/rename-timeout", "2-to-3/restore-timeout"]);
	});

	it("keeps the reverse instruction when starting between the versions", () => {
		const plan = success(History.resolve(history, { from: "2.0.0", to: "3.0.0" }));

		expect(actionIds(plan)).toEqual(["restore-timeout"]);
	});

	it("does not cancel around an intervening action", () => {
		const touch = AddKey.make("touch-timeout", { target: "config", key: "requestTimeout" });
		const intervening = Migration.make("1-to-2", { from: v1, to: v2 })`
			${renameTimeout}
			${touch}
		`;
		const blocked = History.make({
			versions: [v1, v2, v3],
			migrations: [intervening, backward],
			rules: [cancelRoundTrip],
		});
		const plan = success(History.resolve(blocked, { from: "1.0.0", to: "3.0.0" }));

		expect(actionIds(plan)).toEqual(["rename-timeout", "touch-timeout", "restore-timeout"]);
	});

	it("does not cancel around a text-only migration", () => {
		const v4 = Version.make("4.0.0", { previous: v3, changes: [] });
		const manual = Migration.make("2-to-3", {
			from: v2,
			to: v3,
		})`Rotate your API keys by hand.`;
		const later = Migration.make("3-to-4", { from: v3, to: v4 })`${restoreTimeout}`;
		const blocked = History.make({
			versions: [v1, v2, v3, v4],
			migrations: [forward, manual, later],
			rules: [cancelRoundTrip],
		});
		const plan = success(History.resolve(blocked, { from: "1.0.0", to: "4.0.0" }));

		expect(actionIds(plan)).toEqual(["rename-timeout", "restore-timeout"]);
		expect(plan.steps[1]?.guide).toEqual([
			{ _tag: "Text", text: "Rotate your API keys by hand." },
		]);
	});
});

describe("scenario 5: chained replacements", () => {
	const v1 = Version.make("1.0.0", { changes: [] });
	const v2 = Version.make("2.0.0", { previous: v1, changes: [] });
	const v3 = Version.make("3.0.0", { previous: v2, changes: [] });
	const v4 = Version.make("4.0.0", { previous: v3, changes: [] });
	const aToB = rename("a", "b");
	const bToC = rename("b", "c");
	const cToD = rename("c", "d");
	const aToC = rename("a", "c");
	const aToD = rename("a", "d");
	const migrations = [
		Migration.make("1-to-2", { from: v1, to: v2 })`${aToB}`,
		Migration.make("2-to-3", { from: v2, to: v3 })`${bToC}`,
		Migration.make("3-to-4", { from: v3, to: v4 })`${cToD}`,
	] as const;
	const combineAC = Rule.replace("combine-a-c", { match: [aToB, bToC], replacement: [aToC] });
	const combineAD = Rule.replace("combine-a-d", {
		match: [aToC, cToD],
		replacement: [Migration.instruction(aToD)`Rename a to d directly.`],
	});

	it("feeds a replacement into another rule and preserves ordered provenance", () => {
		const history = History.make({
			versions: [v1, v2, v3, v4],
			migrations,
			rules: [combineAD, combineAC],
		});
		const plan = success(History.resolve(history, { from: "1.0.0", to: "4.0.0" }));

		expect(actionIds(plan)).toEqual(["rename-a-d"]);
		const [occurrence] = plan.occurrences;
		expect(occurrence?.id).toBe(
			"combine-a-d(combine-a-c(1-to-2/rename-a-b+2-to-3/rename-b-c)/rename-a-c+3-to-4/rename-c-d)/rename-a-d",
		);
		expect(occurrence?.origin._tag === "Replacement" && occurrence.origin.rule.id).toBe(
			"combine-a-d",
		);
		const first =
			occurrence?.origin._tag === "Replacement" ? occurrence.origin.replaces[0] : undefined;
		expect(
			first?.origin._tag === "Replacement" &&
				first.origin.replaces.map((replaced) => replaced.id),
		).toEqual(["1-to-2/rename-a-b", "2-to-3/rename-b-c"]);
		expect(plan.steps[0]?.guide).toEqual([{ _tag: "Occurrence", occurrence }]);
		expect(plan.steps.map((step) => step.omitted)).toEqual([false, true, true]);
	});

	it("reports rewrite cycles without hanging", () => {
		const forth = Rule.replace("forth", { match: [aToB], replacement: [aToC] });
		const back = Rule.replace("back", { match: [aToC], replacement: [aToB] });
		const history = History.make({
			versions: [v1, v2],
			migrations: [migrations[0]],
			rules: [forth, back],
		});

		expect(failure(History.resolve(history, { from: "1.0.0", to: "2.0.0" }))).toMatchObject({
			_tag: "RewriteCycle",
			rules: ["forth", "back"],
		});
	});

	it("reports a rule that keeps growing the sequence", () => {
		const grow = Rule.replace("grow", { match: [aToB], replacement: [bToC, aToB] });
		const history = History.make({
			versions: [v1, v2],
			migrations: [migrations[0]],
			rules: [grow],
		});

		expect(failure(History.resolve(history, { from: "1.0.0", to: "2.0.0" }))._tag).toBe(
			"RewriteLimitExceeded",
		);
	});

	it("reports conflicting outcomes regardless of registration order", () => {
		const left = Rule.replace("left", { match: [aToB, bToC], replacement: [aToC] });
		const right = Rule.replace("right", {
			match: [bToC, cToD],
			replacement: [rename("b", "d")],
		});
		for (const rules of [
			[left, right],
			[right, left],
		]) {
			const history = History.make({ versions: [v1, v2, v3, v4], migrations, rules });
			const error = failure(History.resolve(history, { from: "1.0.0", to: "4.0.0" }));

			expect(error._tag).toBe("ConflictingRewrites");
			expect(
				error._tag === "ConflictingRewrites" &&
					error.outcomes.map((outcome) => outcome.actions),
			).toEqual(['"rename-a-c","rename-c-d"', '"rename-a-b","rename-b-d"']);
		}
	});

	it("accepts different rule paths that reach the same result", () => {
		const left = Rule.replace("left", { match: [aToB, bToC], replacement: [aToC] });
		const combineBD = Rule.replace("combine-b-d", {
			match: [bToC, cToD],
			replacement: [rename("b", "d")],
		});
		const leftThenD = Rule.replace("left-then-d", { match: [aToC, cToD], replacement: [aToD] });
		const rightThenD = Rule.replace("right-then-d", {
			match: [aToB, rename("b", "d")],
			replacement: [aToD],
		});
		const history = History.make({
			versions: [v1, v2, v3, v4],
			migrations,
			rules: [left, combineBD, leftThenD, rightThenD],
		});

		expect(
			actionIds(success(History.resolve(history, { from: "1.0.0", to: "4.0.0" }))),
		).toEqual(["rename-a-d"]);
	});
});

describe("scenario 6: shortcuts", () => {
	const v1 = Version.make("2.0.1", { changes: [] });
	const v2 = Version.make("2.0.2", { previous: v1, changes: [] });
	const v3 = Version.make("2.0.3", { previous: v2, changes: [] });
	const m2 = addingMigration("2.0.2", v1, v2);
	const m3 = addingMigration("2.0.3", v2, v3);
	const direct = Migration.make("direct-2.0.3", { from: v1, to: v3 })`${AddKey.make("add-both", {
		target: "config",
		key: "both",
	})}`;
	const fast = Shortcut.make("fast-upgrade", {
		from: v1,
		to: v3,
		replaces: [m2, m3],
		migrations: [direct],
	});
	const history = History.make({
		versions: [v1, v2, v3],
		migrations: [m2, m3],
		shortcuts: [fast],
	});

	it("offers the shortcut as a named candidate", () => {
		const error = failure(History.resolve(history, { from: "2.0.1", to: "2.0.3" }));

		expect(
			error._tag === "AmbiguousRoute" && error.candidates.map((candidate) => candidate.id),
		).toEqual(["2.0.1>2.0.2>2.0.3", "2.0.1>[fast-upgrade]>2.0.3"]);
	});

	it("prefers a shortcut over the canonical route it replaces only when asked", () => {
		const plan = success(
			History.resolve(history, { from: "2.0.1", to: "2.0.3", policy: "prefer-shortcuts" }),
		);

		expect(plan.route.hops.map((hop) => hop._tag)).toEqual(["Shortcut"]);
		expect(actionIds(plan)).toEqual(["add-both"]);
	});

	it("keeps unrelated routes ambiguous under prefer-shortcuts", () => {
		const other = Migration.make("other-2.0.3", { from: v1, to: v3 })`${addRetryLimit}`;
		const withOther = History.make({
			versions: [v1, v2, v3],
			migrations: [m2, m3, other],
			shortcuts: [fast],
		});
		const error = failure(
			History.resolve(withOther, { from: "2.0.1", to: "2.0.3", policy: "prefer-shortcuts" }),
		);

		expect(
			error._tag === "AmbiguousRoute" && error.candidates.map((candidate) => candidate.id),
		).toEqual(["2.0.1>2.0.3", "2.0.1>[fast-upgrade]>2.0.3"]);
	});

	it("validates shortcut endpoints and replaced route membership", () => {
		const unrelated = Shortcut.make("unrelated", {
			from: v1,
			to: v3,
			replaces: [m3],
			migrations: [direct],
		});
		const unregistered = Shortcut.make("unregistered", {
			from: v1,
			to: v3,
			replaces: [addingMigration("2.0.2", v1, v2), m3],
			migrations: [direct],
		});
		const invalid = History.make({
			versions: [v1, v2, v3],
			migrations: [m2, m3],
			shortcuts: [unrelated, unregistered],
		});

		expect(History.validate(invalid).map((issue) => [issue._tag, issue.subject])).toEqual([
			["InvalidShortcut", "unregistered"],
			["InvalidShortcut", "unrelated"],
		]);
		expect(failure(History.resolve(invalid, { from: "2.0.1", to: "2.0.3" }))._tag).toBe(
			"InvalidHistory",
		);
	});
});

describe("scenario 7: downgrades", () => {
	const v1 = Version.make("1.0.0", { changes: [] });
	const v2 = Version.make("2.0.0", { previous: v1, changes: [timeoutRenamed] });
	const v3 = Version.make("3.0.0", { previous: v2, changes: [retriesAdded] });
	const up12 = Migration.withRevert(
		Migration.make("1-to-2", {
			from: v1,
			to: v2,
			addresses: [timeoutRenamed],
		})`${renameTimeout}`,
	)`${restoreTimeout}`;
	const up23 = Migration.make("2-to-3", {
		from: v2,
		to: v3,
		addresses: [retriesAdded],
	})`${addRetryLimit}`;
	const history = History.make({ versions: [v1, v2, v3], migrations: [up12, up23] });

	it("plans a declared reverse migration", () => {
		const plan = success(History.resolve(history, { from: "2.0.0", to: "1.0.0" }));

		expect(plan.direction).toBe("downgrade");
		expect(plan.occurrences.map((occurrence) => occurrence.id)).toEqual([
			"1-to-2/revert/restore-timeout",
		]);
	});

	it("reports reachable downgrades, the closest alternative, and blockers", () => {
		const error = failure(History.resolve(history, { from: "3.0.0", to: "1.0.0" }));

		expect(error).toMatchObject({
			_tag: "UnsupportedRoute",
			direction: "downgrade",
			reachable: [],
			closest: [],
			blockers: [
				{
					from: "3.0.0",
					to: "2.0.0",
					reason: 'No migration is declared from "3.0.0" to "2.0.0".',
				},
			],
		});
		expect(
			success(History.downgrades(history, { from: "2.0.0" })).map(
				(entry) => entry.version.id,
			),
		).toEqual(["1.0.0"]);
		expect(success(History.upgrades(history, { from: "1.0.0" }))).toEqual([
			{ version: v2, routes: ["1.0.0>2.0.0"] },
			{ version: v3, routes: ["1.0.0>2.0.0>3.0.0"] },
		]);
	});

	it("lists the closest reachable downgrade along ancestry", () => {
		const v4 = Version.make("4.0.0", { previous: v3, changes: [] });
		const up34 = Migration.noop("3-to-4", { from: v3, to: v4, reversible: true });
		const partial = History.make({
			versions: [v1, v2, v3, v4],
			migrations: [up12, up23, up34],
		});
		const error = failure(History.resolve(partial, { from: "4.0.0", to: "1.0.0" }));

		expect(error).toMatchObject({
			_tag: "UnsupportedRoute",
			reachable: ["3.0.0"],
			closest: ["3.0.0"],
		});
	});
});

describe("parallel groups and structural rules", () => {
	const v1 = Version.make("1.0.0", { changes: [] });
	const v2 = Version.make("2.0.0", { previous: v1, changes: [] });
	const v3 = Version.make("3.0.0", { previous: v2, changes: [] });
	const createConfig = AddKey.make("create-config", { target: "config", key: "file" });
	const updateCreated = RenameKey.make("update-created", {
		target: "config",
		from: "x",
		to: "y",
	});
	const updateSource = RenameKey.make("update-source", { target: "src", from: "x", to: "y" });
	const tasks = Action.parallel([Action.sequence([createConfig, updateCreated]), updateSource]);
	const grouped = Migration.make("1-to-2", { from: v1, to: v2 })`${tasks}`;

	it("keeps the declared group structure in the plan", () => {
		const history = History.make({ versions: [v1, v2], migrations: [grouped] });
		const plan = success(History.resolve(history, { from: "1.0.0", to: "2.0.0" }));

		expect(plan.steps[0]?.node).toMatchObject({
			_tag: "Sequence",
			children: [
				{
					_tag: "Parallel",
					concurrency: "unbounded",
					branches: [
						{
							_tag: "Sequence",
							children: [
								{ id: "1-to-2/create-config" },
								{ id: "1-to-2/update-created" },
							],
						},
						{ id: "1-to-2/update-source" },
					],
				},
			],
		});
	});

	it("simplifies within a branch but never across branches", () => {
		const restoreCreated = RenameKey.make("restore-created", {
			target: "config",
			from: "y",
			to: "x",
		});
		const branchLocal = Rule.replace("branch-local", {
			match: [updateCreated, restoreCreated],
			replacement: [],
		});
		const across = Rule.replace("across", {
			match: [createConfig, updateSource],
			replacement: [],
		});
		const withRestore = Migration.make("1-to-2", { from: v1, to: v2 })`${Action.parallel([
			Action.sequence([createConfig, updateCreated, restoreCreated]),
			updateSource,
		])}`;
		const history = History.make({
			versions: [v1, v2],
			migrations: [withRestore],
			rules: [branchLocal, across],
		});
		const plan = success(History.resolve(history, { from: "1.0.0", to: "2.0.0" }));

		expect(actionIds(plan)).toEqual(["create-config", "update-source"]);
		expect(plan.steps[0]?.node.children[0]?._tag).toBe("Parallel");
	});

	it("rewrites a whole group only through an explicit structural rule", () => {
		const undo = Action.parallel([
			Action.sequence([createConfig, updateCreated]),
			updateSource,
		]);
		const replaceGroup = Rule.replace("replace-group", {
			match: [undo],
			replacement: [AddKey.make("combined", { target: "all", key: "combined" })],
		});
		const after = Migration.make("2-to-3", { from: v2, to: v3 })`${addRetryLimit}`;
		const history = History.make({
			versions: [v1, v2, v3],
			migrations: [grouped, after],
			rules: [replaceGroup],
		});
		const plan = success(History.resolve(history, { from: "1.0.0", to: "3.0.0" }));

		expect(actionIds(plan)).toEqual(["combined", "add-retry-limit"]);
	});

	it("bounds a structural rule that keeps nesting groups", () => {
		const grow = Rule.replace("grow", {
			match: [createConfig],
			replacement: [Action.parallel([createConfig, updateSource])],
		});
		const history = History.make({
			versions: [v1, v2],
			migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${createConfig}`],
			rules: [grow],
		});

		expect(History.validate(history)).toEqual([]);
		expect(failure(History.resolve(history, { from: "1.0.0", to: "2.0.0" }))).toMatchObject({
			_tag: "RewriteLimitExceeded",
			limit: "depth",
			value: 256,
		});
	});

	it("reports a branch rewrite that competes with a whole-group rewrite", () => {
		const pair = Action.parallel([createConfig, updateSource]);
		const inner = Rule.replace("inner", {
			match: [createConfig],
			replacement: [addRetryLimit],
		});
		const outer = Rule.replace("outer", {
			match: [pair],
			replacement: [AddKey.make("combined", { target: "all", key: "combined" })],
		});
		const history = History.make({
			versions: [v1, v2],
			migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${pair}`],
			rules: [inner, outer],
		});
		const error = failure(History.resolve(history, { from: "1.0.0", to: "2.0.0" }));

		expect(
			error._tag === "ConflictingRewrites" && error.outcomes.map((outcome) => outcome.rules),
		).toEqual([["outer"], ["inner"]]);
	});
});

/** Each layer offers two sibling versions to pass through, doubling the routes. */
const diamonds = (layers: number) => {
	let start = Version.make("0.0.0", { changes: [] });
	const versions: Array<Version.Version> = [start];
	const migrations: Array<Migration.Any> = [];
	for (let layer = 0; layer < layers; layer++) {
		const end = Version.make(`${layer + 1}.0.0`, { previous: start, changes: [] });
		for (const minor of [1, 2]) {
			const via = Version.make(`${layer}.${minor}.0`, {
				previous: start,
				changes: [],
			});
			versions.push(via);
			migrations.push(
				Migration.noop(`${start.id}-to-${via.id}`, { from: start, to: via }),
				Migration.noop(`${via.id}-to-${end.id}`, { from: via, to: end }),
			);
		}
		versions.push(end);
		start = end;
	}

	return History.make({ versions, migrations });
};

describe("search limits", () => {
	const v1 = Version.make("1.0.0", { changes: [] });
	const v2 = Version.make("2.0.0", { previous: v1, changes: [] });

	/** `count` independent actions, each with a rule that replaces it. */
	const independentRewrites = (count: number) => {
		const indexes = Array.from({ length: count }, (_, index) => index);
		const migration = Migration.make("1-to-2", { from: v1, to: v2 })`${Action.sequence(
			indexes.map((index) => rename(`x${index}`, `y${index}`)),
		)}`;
		const rules = indexes.map((index) =>
			Rule.replace(`r${index}`, {
				match: [rename(`x${index}`, `y${index}`)],
				replacement: [rename(`x${index}`, `z${index}`)],
			}),
		);

		return History.make({ versions: [v1, v2], migrations: [migration], rules });
	};

	const chain = (length: number) => {
		const steps = Array.from({ length: length + 1 }, (_, index) => rename(`s${index}`, "t"));
		const rules = steps.slice(0, -1).map((step, index) =>
			Rule.replace(`r${index}`, {
				match: [step],
				replacement: [steps[index + 1] ?? step],
			}),
		);

		return History.make({
			versions: [v1, v2],
			migrations: [
				Migration.make("1-to-2", { from: v1, to: v2 })`${steps[0] ?? rename("s", "t")}`,
			],
			rules,
		});
	};

	it("explores at most 10 000 rewrite states", () => {
		// 13 independent rewrites reach 2^13 = 8192 states; 14 reach 16 384.
		expect(
			actionIds(
				success(History.resolve(independentRewrites(13), { from: "1.0.0", to: "2.0.0" })),
			),
		).toHaveLength(13);
		expect(
			failure(History.resolve(independentRewrites(14), { from: "1.0.0", to: "2.0.0" })),
		).toMatchObject({ _tag: "RewriteLimitExceeded", limit: "states", value: 10_000 });
	});

	it("chains at most 256 rule applications", () => {
		expect(
			actionIds(success(History.resolve(chain(256), { from: "1.0.0", to: "2.0.0" }))),
		).toEqual(["rename-s256-t"]);
		expect(failure(History.resolve(chain(257), { from: "1.0.0", to: "2.0.0" }))).toMatchObject({
			_tag: "RewriteLimitExceeded",
			limit: "depth",
			value: 256,
		});
	});

	it("enumerates at most 100 candidate routes", () => {
		expect(failure(History.resolve(diamonds(6), { from: "0.0.0", to: "6.0.0" }))).toMatchObject(
			{
				_tag: "AmbiguousRoute",
				candidates: { length: 64 },
			},
		);
		expect(failure(History.resolve(diamonds(7), { from: "0.0.0", to: "7.0.0" }))).toMatchObject(
			{
				_tag: "TooManyRoutes",
				limit: 100,
			},
		);
	});
});

describe("prose ownership in resolved guides", () => {
	const v1 = Version.make("1.0.0", { changes: [] });
	const v2 = Version.make("2.0.0", { previous: v1, changes: [timeoutRenamed, retriesAdded] });
	const v3 = Version.make("3.0.0", { previous: v2, changes: [timeoutRestored] });
	const configure = Migration.make("configure-v2", {
		from: v1,
		to: v2,
		addresses: [timeoutRenamed, retriesAdded],
	})`
		Shared context for version 2.

		${Migration.instruction(renameTimeout)`Rename the timeout option, keeping its existing value.`}

		${Migration.instruction(addRetryLimit)`Add a retry limit. Start with ${3}.`}
	`;
	const restore = Migration.make("restore-v3", { from: v2, to: v3 })`${restoreTimeout}`;
	const cancel = Rule.replace("cancel", {
		match: [renameTimeout, addRetryLimit, restoreTimeout],
		replacement: [],
	});

	it("omits a cancelled action's instruction block and keeps shared prose", () => {
		const retriesFirst = Migration.make("configure-v2", { from: v1, to: v2 })`
			Shared context for version 2.

			${Migration.instruction(addRetryLimit)`Add a retry limit. Start with ${3}.`}

			${Migration.instruction(renameTimeout)`Rename the timeout option, keeping its existing value.`}
		`;
		const roundTrip = Rule.replace("round-trip", {
			match: [renameTimeout, restoreTimeout],
			replacement: [],
		});
		const history = History.make({
			versions: [v1, v2, v3],
			migrations: [retriesFirst, restore],
			rules: [roundTrip],
		});
		const plan = success(History.resolve(history, { from: "1.0.0", to: "3.0.0" }));
		const guide = plan.steps[0]?.guide.flatMap((item) => {
			if (item._tag === "Text") return [item.text.trim()];
			if (item._tag !== "Occurrence") return [];

			return (
				item.occurrence.instruction?.content.map((part) =>
					part._tag === "Text" ? part.text : "",
				) ?? []
			);
		});

		expect(guide).toEqual([
			"Shared context for version 2.",
			"Add a retry limit. Start with 3.",
			"",
		]);
		expect(plan.steps[1]?.omitted).toBe(true);
		expect(retriesFirst.content.filter((part) => part._tag === "Instruction")).toHaveLength(2);
	});

	it("omits a migration from the guide when rules remove all of its actions", () => {
		const history = History.make({
			versions: [v1, v2, v3],
			migrations: [configure, restore],
			rules: [cancel],
		});
		const plan = success(History.resolve(history, { from: "1.0.0", to: "3.0.0" }));

		expect(plan.steps.map((step) => [step.omitted, step.guide.length])).toEqual([
			[true, 0],
			[true, 0],
		]);
		expect(configure.content[1]).toMatchObject({ _tag: "Instruction", action: renameTimeout });
	});

	it("keeps a deliberately text-only migration", () => {
		const manual = Migration.make("manual", { from: v1, to: v2 })`Back up your database.`;
		const history = History.make({ versions: [v1, v2], migrations: [manual] });
		const plan = success(History.resolve(history, { from: "1.0.0", to: "2.0.0" }));

		expect(plan.steps[0]).toMatchObject({
			omitted: false,
			guide: [{ _tag: "Text", text: "Back up your database." }],
		});
	});
});

const key = (id: string) => RenameKey.make(id, { target: "config", from: id, to: `${id}!` });

const occurrenceIds = (plan: Plan.Any) => plan.occurrences.map((occurrence) => occurrence.id);

describe("identifiers with separator characters", () => {
	it("keeps occurrences of different migrations and actions apart", () => {
		const w1 = Version.make("1", { changes: [] });
		const w2 = Version.make("2", { previous: w1, changes: [] });
		const w3 = Version.make("3", { previous: w2, changes: [] });
		const history = History.make({
			versions: [w1, w2, w3],
			migrations: [
				Migration.make("a", { from: w1, to: w2 })`${key("b/c")}`,
				Migration.make("a/b", { from: w2, to: w3 })`${key("c")}`,
			],
		});

		expect(occurrenceIds(success(History.resolve(history, { from: "1", to: "3" })))).toEqual([
			"a/b\\/c",
			"a\\/b/c",
		]);
	});

	it("keeps the reverse direction distinct from a migration named like it", () => {
		const w1 = Version.make("1", { changes: [] });
		const w2 = Version.make("2", { previous: w1, changes: [] });
		const x = key("x");
		const reverse = History.make({
			versions: [w1, w2],
			migrations: [
				Migration.withRevert(Migration.make("m", { from: w1, to: w2 })`${key("y")}`)`${x}`,
			],
		});
		const forward = History.make({
			versions: [w1, w2],
			migrations: [Migration.make("m/revert", { from: w1, to: w2 })`${x}`],
		});

		expect(occurrenceIds(success(History.resolve(reverse, { from: "2", to: "1" })))).toEqual([
			"m/revert/x",
		]);
		expect(occurrenceIds(success(History.resolve(forward, { from: "1", to: "2" })))).toEqual([
			"m\\/revert/x",
		]);
	});

	it("keeps a replacement apart from a declared occurrence with the same text", () => {
		const w1 = Version.make("1", { changes: [] });
		const w2 = Version.make("2", { previous: w1, changes: [] });
		const w3 = Version.make("3", { previous: w2, changes: [] });
		const b = key("b");
		const c = key("c");
		const history = History.make({
			versions: [w1, w2, w3],
			migrations: [
				Migration.make("a", { from: w1, to: w2 })`${b}`,
				Migration.make("r(a/b)", { from: w2, to: w3 })`${c}`,
			],
			rules: [Rule.replace("r", { match: [b], replacement: [c] })],
		});

		expect(occurrenceIds(success(History.resolve(history, { from: "1", to: "3" })))).toEqual([
			"r(a/b)/c",
			"r\\(a\\/b\\)/c",
		]);
	});

	it("reports routes through differently named versions as ambiguous", () => {
		const s = Version.make("s", { changes: [] });
		const a = Version.make("a", { previous: s, changes: [] });
		const b = Version.make("b", { previous: a, changes: [] });
		const ab = Version.make("a>b", { previous: b, changes: [] });
		const t = Version.make("t", { previous: ab, changes: [] });
		const sa = Migration.make("s-a", { from: s, to: a })`${key("sa")}`;
		const ab1 = Migration.make("a-b", { from: a, to: b })`${key("ab")}`;
		const bt = Migration.make("b-t", { from: b, to: t })`${key("bt")}`;
		const history = History.make({
			versions: [s, a, b, ab, t],
			migrations: [
				sa,
				ab1,
				bt,
				Migration.make("s-ab", { from: s, to: ab })`${key("s-ab")}`,
				Migration.make("ab-t", { from: ab, to: t })`${key("ab-t")}`,
			],
			shortcuts: [
				Shortcut.make("fast]", {
					from: s,
					to: t,
					replaces: [sa, ab1, bt],
					migrations: [Migration.make("s-t", { from: s, to: t })`${key("st")}`],
				}),
			],
		});

		const error = failure(History.resolve(history, { from: "s", to: "t" }));

		const candidates = error._tag === "AmbiguousRoute" ? error.candidates : [];

		expect(candidates).toHaveLength(3);
		expect(candidates.map((candidate) => candidate.id)).toEqual(
			expect.arrayContaining(["s>[fast\\]]>t", "s>a>b>t", "s>a\\>b>t"]),
		);
		expect(
			occurrenceIds(
				success(History.resolve(history, { from: "s", to: "t", route: "s>a\\>b>t" })),
			),
		).toEqual(["s-ab/s-ab", "ab-t/ab-t"]);
	});
});

describe("template prose", () => {
	it("removes indentation after a first line on the opening backtick and surrounding blank lines", () => {
		const inline = Change.make("inline")`Rename the option.
			Then restart the service.`;
		const padded = Change.make("padded")`

			Rename the option.

		`;

		expect(inline.description).toBe("Rename the option.\nThen restart the service.");
		expect(padded.description).toBe("Rename the option.");
	});
});

const reverting = (inner: Change.Any) => Change.make("outer", {}, { reverts: [inner] })`Outer.`;

const backporting = (inner: Change.Any) =>
	Change.make("backport", {}, { backportOf: inner })`Backport.`;

describe("validation", () => {
	const v1 = Version.make("1.0.0", { changes: [timeoutRenamed] });
	const v2 = Version.make("2.0.0", { previous: v1, changes: [] });

	it("finds conflicts between changes that repeated definitions refer to", () => {
		const first = Change.make("inner", { x: 1 })`Inner.`;
		const second = Change.make("inner", { x: 2 })`Inner.`;
		const w1 = Version.make("1", { changes: [reverting(first), backporting(first)] });
		const w2 = Version.make("2", {
			previous: w1,
			changes: [reverting(second), backporting(second)],
		});

		expect(
			History.validate(History.make({ versions: [w1, w2], migrations: [] })).map((issue) => [
				issue._tag,
				issue.subject,
			]),
		).toEqual([["ConflictingChange", "inner"]]);
	});

	it("accepts a rule that changes structure and rejects one that changes nothing", () => {
		const a = key("a");
		const b = key("b");
		const declared = Migration.make("1-to-2", { from: v1, to: v2 })`${a}${b}`;
		const ruleIssues = (rule: Rule.Any) =>
			History.validate(
				History.make({ versions: [v1, v2], migrations: [declared], rules: [rule] }),
			).map((issue) => [issue._tag, issue.subject]);

		expect(
			ruleIssues(
				Rule.replace("parallel", { match: [a, b], replacement: [Action.parallel([a, b])] }),
			),
		).toEqual([]);
		expect(ruleIssues(Rule.replace("same", { match: [a, b], replacement: [a, b] }))).toEqual([
			["InvalidRule", "same"],
		]);
	});

	it("rejects registering a migration and its withRevert result together", () => {
		const forward = Migration.make("1-to-2", { from: v1, to: v2 })`${renameTimeout}`;
		const reversible = Migration.withRevert(forward)`${restoreTimeout}`;
		const history = History.make({ versions: [v1, v2], migrations: [forward, reversible] });

		expect(History.validate(history).map((issue) => issue._tag)).toEqual([
			"DuplicateMigration",
		]);
	});

	it("rejects a repeated action interpolation and suggests Action.ref", () => {
		const repeated = Migration.make("1-to-2", { from: v1, to: v2 })`
			${renameTimeout}
			Then check that ${renameTimeout} worked; compare ${Action.ref(renameTimeout)}.
		`;
		const [issue] = History.validate(
			History.make({ versions: [v1, v2], migrations: [repeated] }),
		);

		expect(issue).toMatchObject({ _tag: "DuplicateOccurrence", subject: "1-to-2" });
		expect(issue?.message).toContain("occurs 2 times");
		expect(issue?.message).toContain("Action.ref");
	});

	it("reports conflicting definitions, empty migrations, and unregistered versions together", () => {
		const conflicting = { ...timeoutRenamed, description: "Something else." };
		const v3 = Version.make("3.0.0", { previous: v2, changes: [conflicting] });
		const empty = Migration.make("empty", { from: v2, to: v1 })``;
		const emptyGroup = Migration.make("empty-group", {
			from: v1,
			to: v3,
		})`${Action.sequence([])}`;
		const sameId = RenameKey.make("rename-timeout", { target: "other", from: "a", to: "b" });
		const conflictingAction = Migration.make("2-to-3", { from: v2, to: v3 })`${sameId}`;
		const history = History.make({
			versions: [v1, v3],
			migrations: [
				empty,
				emptyGroup,
				conflictingAction,
				Migration.make("1-to-2", { from: v1, to: v2 })`${renameTimeout}`,
			],
		});

		expect(History.validate(history).map((issue) => [issue._tag, issue.subject])).toEqual([
			["ConflictingAction", "rename-timeout"],
			["ConflictingChange", timeoutRenamed.id],
			["EmptyMigration", "empty"],
			["EmptyMigration", "empty-group"],
			["UnregisteredVersion", "2.0.0"],
		]);
	});

	it("rejects unsupported interpolations in types and at declaration time", () => {
		// @ts-expect-error objects are not interpolations.
		expect(() => Migration.make("bad", { from: v1, to: v2 })`${{ not: "an action" }}`).toThrow(
			"cannot interpolate an object",
		);
		// @ts-expect-error an instruction block cannot declare another occurrence.
		expect(() => Migration.instruction(renameTimeout)`${renameTimeout}`).toThrow(
			"would declare another occurrence",
		);
	});
});
