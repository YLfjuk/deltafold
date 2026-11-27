import type * as Action from "../../foundation/action.ts";
import type * as Migration from "../../foundation/migration.ts";
import type { Direction, Occurrence } from "../../foundation/plan.ts";
import type * as Rule from "../../foundation/rule.ts";

// Author identifiers may contain any character. Each format escapes its own separators,
// and the backslash itself, so distinct components never produce the same identifier.
const escape = (value: string, separators: RegExp) => value.replace(separators, "\\$&");

const occurrencePart = (id: string) => escape(id, /[\\/()+]/g);

const routePart = (id: string) => escape(id, /[\\>[\]]/g);

export const stepId = (migration: Migration.Any, direction: Direction): string =>
	direction === "forward"
		? occurrencePart(migration.id)
		: `${occurrencePart(migration.id)}/revert`;

export const declaredOccurrenceId = (
	migration: Migration.Any,
	direction: Direction,
	action: Action.Any,
): string => `${stepId(migration, direction)}/${occurrencePart(action.id)}`;

/**
 * Replaced identifiers are already escaped occurrence identifiers, so they nest without
 * further escaping.
 */
export const replacementOccurrenceId = (
	rule: Rule.Any,
	replaced: ReadonlyArray<Occurrence>,
	action: Action.Any,
): string =>
	`${occurrencePart(rule.id)}(${replaced.map((occurrence) => occurrence.id).join("+")})/${occurrencePart(action.id)}`;

export const routeStart = (version: string): string => routePart(version);

export const routeHop = (to: string): string => `>${routePart(to)}`;

export const routeShortcut = (shortcut: string, to: string): string =>
	`>[${routePart(shortcut)}]>${routePart(to)}`;
