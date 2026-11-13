import type * as Action from "../../foundation/action.ts";
import type * as Migration from "../../foundation/migration.ts";
import type { Direction, Occurrence } from "../../foundation/plan.ts";
import type * as Rule from "../../foundation/rule.ts";

// Author identifiers may contain any character. Each format escapes its own separators,
// and the backslash itself, so distinct components never produce the same identifier.
const escape = (value: string, separators: RegExp) => value.replace(separators, "\\$&");

const occurrencePart = (id: string) => escape(id, /[\\/()+]/g);

const routePart = (id: string) => escape(id, /[\\>[\]]/g);

/** `<migration>/<action>` forward, `<migration>/revert/<action>` in reverse. */
export const declaredOccurrenceId = (
	migration: Migration.Any,
	direction: Direction,
	action: Action.Any,
): string =>
	direction === "forward"
		? `${occurrencePart(migration.id)}/${occurrencePart(action.id)}`
		: `${occurrencePart(migration.id)}/revert/${occurrencePart(action.id)}`;

/**
 * `<rule>(<replaced>+<replaced>)/<action>`. Replaced identifiers are complete occurrence
 * identifiers, so they nest without further escaping.
 */
export const replacementOccurrenceId = (
	rule: Rule.Any,
	replaced: ReadonlyArray<Occurrence>,
	action: Action.Any,
): string =>
	`${occurrencePart(rule.id)}(${replaced.map((occurrence) => occurrence.id).join("+")})/${occurrencePart(action.id)}`;

/** The first version of a route identifier. */
export const routeStart = (version: string): string => routePart(version);

/** A migration hop: `>` and the target version. */
export const routeHop = (to: string): string => `>${routePart(to)}`;

/** A shortcut hop: `>[shortcut]>` and the target version. */
export const routeShortcut = (shortcut: string, to: string): string =>
	`>[${routePart(shortcut)}]>${routePart(to)}`;
