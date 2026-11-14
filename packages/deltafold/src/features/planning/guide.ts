import type * as Action from "../../foundation/action.ts";
import type * as Migration from "../../foundation/migration.ts";
import type { GuideItem, Occurrence } from "../../foundation/plan.ts";

/** The declared occurrence a retained occurrence is rendered at. */
const anchorOf = (occurrence: Occurrence): Occurrence => {
	if (occurrence.origin._tag === "Declared") return occurrence;

	const first = occurrence.origin.replaces[0];

	return first === undefined ? occurrence : anchorOf(first);
};

/**
 * Resolves a migration's content against the occurrences that survived optimization.
 * Removed occurrences disappear with their instruction blocks. Replacements render at
 * the position of the first occurrence they replaced, using their own instruction or
 * description. Unassociated prose stays.
 */
export const resolveGuide = (
	content: Migration.Content,
	retained: ReadonlyArray<Occurrence>,
	declaredId: (action: Action.Any) => string,
): ReadonlyArray<GuideItem> => {
	const byAnchor = new Map<string, Array<Occurrence>>();
	for (const occurrence of retained) {
		const anchor = anchorOf(occurrence).id;
		const list = byAnchor.get(anchor) ?? [];
		list.push(occurrence);
		byAnchor.set(anchor, list);
	}

	const renderStep = (step: Action.Step): ReadonlyArray<GuideItem> => {
		if (step._tag === "Action" || step._tag === "Instruction") {
			const action = step._tag === "Action" ? step : step.action;

			return (byAnchor.get(declaredId(action)) ?? []).map((occurrence) => ({
				_tag: "Occurrence",
				occurrence,
			}));
		}

		const children = (step._tag === "Sequence" ? step.children : step.branches)
			.map((child) => renderStep(child))
			.filter((items) => items.length > 0);
		if (children.length === 0) return [];

		return [{ _tag: "Group", kind: step._tag, children }];
	};

	return content.flatMap((fragment): ReadonlyArray<GuideItem> => {
		if (fragment._tag === "Text" || fragment._tag === "ActionRef") return [fragment];

		return renderStep(fragment);
	});
};
