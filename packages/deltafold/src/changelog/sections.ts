import { pipeable } from "../internal/pipeable.ts";
import type { Version } from "../version.ts";
import { isBlock, type Anchor, type Block, type PluginOutput, type Section } from "./document.ts";

/** Marks a section as the section of one release. */
export const asRelease = (section: Section, version: Version): Section =>
	pipeable({ ...section, release: version });

/** Inserts blocks at an anchor of a section, after earlier insertions at that anchor. */
export const insert = (section: Section, at: Anchor, blocks: ReadonlyArray<Block>): Section => {
	if (blocks.length === 0) return section;
	if (at.part === "title") {
		return at.position === "pre"
			? pipeable({ ...section, before: [...section.before, ...blocks] })
			: pipeable({ ...section, after: [...section.after, ...blocks] });
	}

	return at.position === "pre"
		? pipeable({ ...section, children: [...blocks, ...section.children] })
		: pipeable({ ...section, children: [...section.children, ...blocks] });
};

export const blocksOf = (output: PluginOutput): ReadonlyArray<Block> => {
	if (output === null) return [];
	if (isBlock(output)) return [output];

	return output;
};
