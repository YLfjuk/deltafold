import type { Version } from "../../foundation/version.ts";
import {
	isBlock,
	SectionValue,
	type Anchor,
	type Block,
	type PluginOutput,
	type Section,
} from "./document.ts";

/** Marks a section as the section of one release. */
export const asRelease = (section: Section, version: Version): Section =>
	new SectionValue({ ...section, release: version });

/** Content that one plugin contributes at an anchor. */
export type Contribution = { readonly at: Anchor; readonly blocks: ReadonlyArray<Block> };

/** Inserts contributions in configuration order. Each anchor receives its blocks at once. */
export const insertAll = (
	section: Section,
	contributions: ReadonlyArray<Contribution>,
): Section => {
	const at = (part: Anchor["part"], position: Anchor["position"]) =>
		contributions
			.filter(
				(contribution) =>
					contribution.at.part === part && contribution.at.position === position,
			)
			.flatMap((contribution) => contribution.blocks);

	return new SectionValue({
		...section,
		before: [...section.before, ...at("title", "pre")],
		after: [...section.after, ...at("title", "post")],
		children: [...at("body", "pre"), ...section.children, ...at("body", "post")],
	});
};

export const blocksOf = (output: PluginOutput): ReadonlyArray<Block> => {
	if (output === null) return [];
	if (isBlock(output)) return [output];

	return output;
};
