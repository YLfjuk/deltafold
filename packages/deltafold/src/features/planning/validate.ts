import { Array as Arr, Equal, Graph, Option, Order } from "effect";

import type * as Action from "../../foundation/action.ts";
import type { Change } from "../../foundation/change.ts";
import type * as Migration from "../../foundation/migration.ts";
import type * as Rule from "../../foundation/rule.ts";
import type * as Shortcut from "../../foundation/shortcut.ts";
import type { Version } from "../../foundation/version.ts";

/**
 * A problem in a history's declarations.
 *
 * @since @next
 */
export type Issue = {
	readonly _tag:
		| "DuplicateVersion"
		| "UnregisteredVersion"
		| "AncestryCycle"
		| "ConflictingChange"
		| "ConflictingAction"
		| "DuplicateMigration"
		| "DuplicateEdge"
		| "SelfMigration"
		| "EmptyMigration"
		| "DuplicateOccurrence"
		| "DuplicateRule"
		| "InvalidRule"
		| "DuplicateShortcut"
		| "InvalidShortcut";
	/** The identifier of the declaration the issue is about. */
	readonly subject: string;
	readonly message: string;
};

export type Declarations = {
	readonly versions: ReadonlyArray<Version>;
	readonly migrations: ReadonlyArray<Migration.Any>;
	readonly rules: ReadonlyArray<Rule.Any>;
	readonly shortcuts: ReadonlyArray<Shortcut.Any>;
};

const issueOrder = Order.combine(
	Order.combine(
		Order.mapInput(Order.String, (issue: Issue) => issue._tag),
		Order.mapInput(Order.String, (issue: Issue) => issue.subject),
	),
	Order.mapInput(Order.String, (issue: Issue) => issue.message),
);

/** Action instances declared by steps, in declaration order. */
export const actionsOfSteps = (steps: ReadonlyArray<Action.Step>): ReadonlyArray<Action.Any> =>
	steps.flatMap((step): ReadonlyArray<Action.Any> => {
		switch (step._tag) {
			case "Action":
				return [step];
			case "Instruction":
				return [step.action];
			case "Sequence":
				return actionsOfSteps(step.children);
		}

		return actionsOfSteps(step.branches);
	});

export const stepsOf = (content: Migration.Content): ReadonlyArray<Action.Step> =>
	content.flatMap((fragment) =>
		fragment._tag === "Text" || fragment._tag === "ActionRef" ? [] : [fragment],
	);

/** Whether two definitions with the same identifier describe the same change. */
const sameDefinition = (self: Change, that: Change): boolean =>
	self === that ||
	(self.id === that.id &&
		self.kind === that.kind &&
		self.breaking === that.breaking &&
		self.description === that.description &&
		self.backportOf?.id === that.backportOf?.id &&
		self.reverts.length === that.reverts.length &&
		self.reverts.every((change, index) => change.id === that.reverts[index]?.id));

/** Whether content declares at least one occurrence. Empty groups declare none. */
const hasOccurrences = (content: Migration.Content): boolean =>
	actionsOfSteps(stepsOf(content)).length > 0;

/** Whether content has prose or mentions. */
export const hasProse = (content: Migration.Content): boolean =>
	content.some(
		(fragment) =>
			fragment._tag === "ActionRef" ||
			(fragment._tag === "Text" && fragment.text.trim() !== ""),
	);

const sameAction = (self: Action.Any, that: Action.Any) =>
	self === that || (self.kind === that.kind && Equal.equals(self.payload, that.payload));

/** Collects every distinct migration: registered ones and those inside shortcuts. */
export const allMigrations = (declarations: Declarations): ReadonlyArray<Migration.Any> => {
	const result: Array<Migration.Any> = [...declarations.migrations];
	for (const shortcut of declarations.shortcuts) {
		for (const migration of shortcut.migrations) {
			if (!result.includes(migration)) result.push(migration);
		}
	}

	return result;
};

const isChain = (migrations: ReadonlyArray<Migration.Any>, from: Version, to: Version): boolean => {
	let current = from.id;
	for (const migration of migrations) {
		if (migration.from.id !== current) return false;
		current = migration.to.id;
	}

	return migrations.length > 0 && current === to.id;
};

export const validate = (declarations: Declarations): ReadonlyArray<Issue> => {
	const issues: Array<Issue> = [];
	const issue = (tag: Issue["_tag"], subject: string, message: string) =>
		issues.push({ _tag: tag, subject, message });

	// Versions and ancestry.
	const versions = new Map<string, Version>();
	for (const version of declarations.versions) {
		if (versions.has(version.id)) {
			issue(
				"DuplicateVersion",
				version.id,
				`Version "${version.id}" is registered more than once.`,
			);
			continue;
		}
		versions.set(version.id, version);
	}
	const unregistered = new Map<string, Array<string>>();
	const requireVersion = (version: Version, referencedBy: string) => {
		if (versions.get(version.id) !== undefined) return;

		const referrers = unregistered.get(version.id) ?? [];
		if (!referrers.includes(referencedBy)) referrers.push(referencedBy);
		unregistered.set(version.id, referrers);
	};
	for (const version of versions.values()) {
		if (version.previous !== undefined)
			requireVersion(version.previous, `version "${version.id}"`);
	}
	const ancestry = Graph.directed<string, undefined>((graph) => {
		const nodes = new Map<string, Graph.NodeIndex>();
		for (const id of versions.keys()) nodes.set(id, Graph.addNode(graph, id));
		for (const version of versions.values()) {
			const source = nodes.get(version.id);
			const target =
				version.previous === undefined ? undefined : nodes.get(version.previous.id);
			if (source !== undefined && target !== undefined)
				Graph.addEdge(graph, source, target, undefined);
		}
	});
	const cycle = Graph.findCycle(ancestry);
	if (Option.isSome(cycle)) {
		const ids = cycle.value.path.flatMap((index) =>
			Option.toArray(Graph.getNode(ancestry, index)),
		);
		issue(
			"AncestryCycle",
			ids[0] ?? "",
			`Release ancestry contains a cycle: ${ids.join(" -> ")}.`,
		);
	}

	// Change definitions.
	const changes = new Map<string, Change>();
	const visitChange = (change: Change) => {
		const known = changes.get(change.id);
		if (known !== undefined) {
			if (!sameDefinition(known, change)) {
				issue(
					"ConflictingChange",
					change.id,
					`Change "${change.id}" has conflicting definitions.`,
				);
			}

			return;
		}
		changes.set(change.id, change);
		for (const reverted of change.reverts) visitChange(reverted);
		if (change.backportOf !== undefined) visitChange(change.backportOf);
	};
	for (const version of declarations.versions) {
		for (const change of version.changes) visitChange(change);
	}

	// Action identities.
	const actions = new Map<string, Action.Any>();
	const conflicting = new Set<string>();
	const visitAction = (action: Action.Any) => {
		const known = actions.get(action.id);
		if (known === undefined) {
			actions.set(action.id, action);

			return;
		}
		if (!sameAction(known, action) && !conflicting.has(action.id)) {
			conflicting.add(action.id);
			issue(
				"ConflictingAction",
				action.id,
				`Action "${action.id}" has conflicting definitions; action identifiers must be unique.`,
			);
		}
	};

	// Migrations.
	const migrations = allMigrations(declarations);
	const migrationIds = new Map<string, Migration.Any>();
	const registered = new Set<Migration.Any>();
	for (const migration of declarations.migrations) {
		if (registered.has(migration) || migrationIds.has(migration.id)) {
			issue(
				"DuplicateMigration",
				migration.id,
				`Migration "${migration.id}" is registered more than once. Register a migration once; register the result of Migration.withRevert in place of the original.`,
			);
		}
		registered.add(migration);
		migrationIds.set(migration.id, migration);
	}
	for (const migration of migrations) {
		const known = migrationIds.get(migration.id);
		if (known !== undefined && known !== migration && !registered.has(migration)) {
			issue(
				"DuplicateMigration",
				migration.id,
				`Migration "${migration.id}" has another definition inside a shortcut.`,
			);
		}
		if (known === undefined) migrationIds.set(migration.id, migration);

		requireVersion(migration.from, `migration "${migration.id}"`);
		requireVersion(migration.to, `migration "${migration.id}"`);
		if (migration.from.id === migration.to.id) {
			issue(
				"SelfMigration",
				migration.id,
				`Migration "${migration.id}" starts and ends at the same version.`,
			);
		}
		for (const change of migration.addresses) visitChange(change);

		const sides: ReadonlyArray<[string, Migration.Content | undefined]> = [
			["forward", migration.content],
			["revert", migration.revert],
		];
		for (const [direction, content] of sides) {
			if (content === undefined) continue;
			if (!migration.noop && !hasOccurrences(content) && !hasProse(content)) {
				issue(
					"EmptyMigration",
					migration.id,
					`The ${direction} side of migration "${migration.id}" is empty. Use Migration.noop to declare a zero-work transition.`,
				);
			}
			const counts = new Map<string, number>();
			for (const action of actionsOfSteps(stepsOf(content))) {
				visitAction(action);
				counts.set(action.id, (counts.get(action.id) ?? 0) + 1);
			}
			for (const [actionId, count] of counts) {
				if (count < 2) continue;

				issue(
					"DuplicateOccurrence",
					migration.id,
					`Action "${actionId}" occurs ${count} times in the ${direction} side of migration "${migration.id}". Use Action.ref to mention an action, or a separate action instance to repeat the work.`,
				);
			}
		}
	}

	// Edges. Each pair of versions has at most one migration side, so a transition's work
	// lives in one migration.
	const edgeSides = new Map<
		string,
		{ readonly from: string; readonly to: string; readonly labels: Array<string> }
	>();
	const addSide = (from: Version, to: Version, label: string) => {
		const key = JSON.stringify([from.id, to.id]);
		const side = edgeSides.get(key) ?? { from: from.id, to: to.id, labels: [] };
		side.labels.push(label);
		edgeSides.set(key, side);
	};
	// A migration registered twice is already a DuplicateMigration issue.
	for (const migration of new Set(migrationIds.values())) {
		if (!registered.has(migration)) continue;
		addSide(migration.from, migration.to, `"${migration.id}"`);
		if (migration.revert !== undefined)
			addSide(migration.to, migration.from, `the revert of "${migration.id}"`);
	}
	for (const { from, to, labels } of edgeSides.values()) {
		if (labels.length < 2) continue;

		issue(
			"DuplicateEdge",
			`${from} -> ${to}`,
			`${labels.join(" and ")} both go from "${from}" to "${to}". Merge them into one migration.`,
		);
	}

	// Rules.
	const rules = new Set<string>();
	for (const rule of declarations.rules) {
		if (rules.has(rule.id)) {
			issue("DuplicateRule", rule.id, `Rule "${rule.id}" is registered more than once.`);
		}
		rules.add(rule.id);
		if (rule.match.length === 0) {
			issue("InvalidRule", rule.id, `Rule "${rule.id}" matches nothing.`);
		}
		const patternActions = actionsOfSteps(rule.match);
		const replacementActions = actionsOfSteps(rule.replacement);
		for (const action of [...patternActions, ...replacementActions]) visitAction(action);
		const unique = new Set(replacementActions.map((action) => action.id));
		if (unique.size !== replacementActions.length) {
			issue(
				"InvalidRule",
				rule.id,
				`Rule "${rule.id}" repeats an action in its replacement.`,
			);
		}
		const sameIds =
			patternActions.length === replacementActions.length &&
			patternActions.every((action, index) => action.id === replacementActions[index]?.id);
		if (
			rule.match.length > 0 &&
			sameIds &&
			rule.match.every((pattern) => pattern._tag === "Action")
		) {
			issue("InvalidRule", rule.id, `Rule "${rule.id}" replaces its match with itself.`);
		}
	}

	// Shortcuts.
	const shortcuts = new Set<string>();
	for (const shortcut of declarations.shortcuts) {
		if (shortcuts.has(shortcut.id)) {
			issue(
				"DuplicateShortcut",
				shortcut.id,
				`Shortcut "${shortcut.id}" is registered more than once.`,
			);
		}
		shortcuts.add(shortcut.id);
		requireVersion(shortcut.from, `shortcut "${shortcut.id}"`);
		requireVersion(shortcut.to, `shortcut "${shortcut.id}"`);
		const unknown = shortcut.replaces.filter((migration) => !registered.has(migration));
		if (unknown.length > 0) {
			issue(
				"InvalidShortcut",
				shortcut.id,
				`Shortcut "${shortcut.id}" replaces unregistered migrations: ${unknown.map((migration) => migration.id).join(", ")}.`,
			);
		}
		if (!isChain(shortcut.replaces, shortcut.from, shortcut.to)) {
			issue(
				"InvalidShortcut",
				shortcut.id,
				`Shortcut "${shortcut.id}" must replace a consecutive route from "${shortcut.from.id}" to "${shortcut.to.id}".`,
			);
		}
		if (!isChain(shortcut.migrations, shortcut.from, shortcut.to)) {
			issue(
				"InvalidShortcut",
				shortcut.id,
				`The migrations of shortcut "${shortcut.id}" must form a route from "${shortcut.from.id}" to "${shortcut.to.id}".`,
			);
		}
	}

	for (const [id, referrers] of unregistered) {
		issue(
			"UnregisteredVersion",
			id,
			`Version "${id}" is referenced by ${referrers.join(", ")} but is not registered.`,
		);
	}

	return Arr.sort(issues, issueOrder);
};
