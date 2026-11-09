import type * as Mdast from "mdast";
import { sanitizeUri } from "micromark-util-sanitize-uri";

import {
	DocumentError,
	type Block,
	type Document,
	type Inline,
} from "../features/documents/document.ts";

/** Link schemes kept in rendered output. Relative URLs are always kept. */
const safeSchemes = /^(https?|mailto)$/i;

const maximumLevel = 6;

const isDepth = (level: number): level is Mdast.Heading["depth"] =>
	Number.isInteger(level) && level >= 1 && level <= maximumLevel;

const lowerInline = (value: Inline): Mdast.PhrasingContent => {
	switch (value._tag) {
		case "Text":
			return { type: "text", value: value.value };
		case "Code":
			return { type: "inlineCode", value: value.value };
		case "Link":
			return {
				type: "link",
				url: sanitizeUri(value.url, safeSchemes),
				children: value.children.map(lowerInline),
			};
		case "Strong":
			return { type: "strong", children: value.children.map(lowerInline) };
	}

	return { type: "emphasis", children: value.children.map(lowerInline) };
};

type Scope = { readonly ids: Set<string>; readonly label: string };

const lowerBlocks = (
	blocks: ReadonlyArray<Block>,
	depth: number,
	scope: Scope,
): Array<Mdast.BlockContent> =>
	blocks.flatMap((block): Array<Mdast.BlockContent> => {
		switch (block._tag) {
			case "Paragraph":
				return [{ type: "paragraph", children: block.children.map(lowerInline) }];
			case "CodeBlock":
				return [{ type: "code", value: block.value, lang: block.lang ?? null }];
			case "List":
				return [
					{
						type: "list",
						ordered: block.ordered,
						spread: false,
						children: block.items.map((item) => ({
							type: "listItem",
							spread: false,
							children: lowerBlocks(item, depth, scope),
						})),
					},
				];
		}

		if (scope.ids.has(block.id)) {
			throw new DocumentError({
				reason: "duplicate-section",
				message: `Section "${block.id}" appears more than once in ${scope.label}.`,
			});
		}
		scope.ids.add(block.id);
		const inner =
			block.release === undefined
				? scope
				: { ids: new Set<string>(), label: `release "${block.release.id}"` };

		if (block.title === undefined) {
			return [
				...lowerBlocks(block.before, depth, inner),
				...lowerBlocks(block.after, depth, inner),
				...lowerBlocks(block.children, depth, inner),
			];
		}

		const level = block.title.level ?? depth;
		if (!isDepth(level)) {
			throw new DocumentError({
				reason: "heading-level",
				message: `Section "${block.id}" needs heading level ${level}, but levels range from 1 to ${maximumLevel}.`,
			});
		}

		return [
			...lowerBlocks(block.before, level + 1, inner),
			{ type: "heading", depth: level, children: block.title.children.map(lowerInline) },
			...lowerBlocks(block.after, level + 1, inner),
			...lowerBlocks(block.children, level + 1, inner),
		];
	});

/**
 * Lowers a document to an mdast root. Untitled sections contribute only their content,
 * and titled sections get the next heading level unless their title sets one. Link URLs
 * with a scheme other than http, https, or mailto become empty.
 *
 * Throws `DocumentError` when a section identifier repeats within the document or within
 * one release, or when a heading level falls outside 1 to 6.
 */
export const toMdast = (document: Document): Mdast.Root => ({
	type: "root",
	children: lowerBlocks(document.children, 1, { ids: new Set(), label: "the document" }),
});
