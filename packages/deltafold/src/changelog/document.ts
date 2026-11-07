/**
 * Format-neutral document values. A small semantic layer adds sections with stable
 * identifiers, insertion points, and automatic heading levels, then lowers to mdast so
 * existing serializers handle formatting and escaping.
 *
 * @packageDocumentation
 */
import { Data, Predicate, type Pipeable } from "effect";
import type * as Mdast from "mdast";

import { pipeable } from "../internal/pipeable.ts";
import type { Package } from "../package.ts";
import type { Version } from "../version.ts";

/** @since @next */
export type Text = { readonly _tag: "Text"; readonly value: string };
/** @since @next */
export type Code = { readonly _tag: "Code"; readonly value: string };
/** @since @next */
export type Link = {
	readonly _tag: "Link";
	readonly url: string;
	readonly children: ReadonlyArray<Inline>;
};
/** @since @next */
export type Strong = { readonly _tag: "Strong"; readonly children: ReadonlyArray<Inline> };
/** @since @next */
export type Emphasis = { readonly _tag: "Emphasis"; readonly children: ReadonlyArray<Inline> };

/**
 * Phrasing content.
 *
 * @since @next
 */
export type Inline = Text | Code | Link | Strong | Emphasis;

/** @since @next */
export type Paragraph = { readonly _tag: "Paragraph"; readonly children: ReadonlyArray<Inline> };
/** @since @next */
export type List = {
	readonly _tag: "List";
	readonly ordered: boolean;
	/** One entry per item. */
	readonly items: ReadonlyArray<ReadonlyArray<Block>>;
};
/** @since @next */
export type CodeBlock = {
	readonly _tag: "CodeBlock";
	readonly value: string;
	readonly lang: string | undefined;
};

/** @since @next */
export type Title = Pipeable.Pipeable & {
	readonly _tag: "Title";
	readonly children: ReadonlyArray<Inline>;
	/** An absolute heading level. Absent means the level follows section nesting. */
	readonly level: number | undefined;
};

/**
 * A titled part of a document. Its `id` must be unique within the containing release,
 * or within the document outside releases.
 *
 * @since @next
 */
export type Section = Pipeable.Pipeable & {
	readonly _tag: "Section";
	readonly id: string;
	readonly title: Title | undefined;
	/** Content inserted before the title. */
	readonly before: ReadonlyArray<Block>;
	/** Content inserted after the title, before the body. */
	readonly after: ReadonlyArray<Block>;
	readonly children: ReadonlyArray<Block>;
	/** Set on a release section, which scopes the identifiers of its sections. */
	readonly release: Version | undefined;
};

/** @since @next */
export type Block = Paragraph | List | CodeBlock | Section;

/**
 * A complete document returned by changelog builders.
 *
 * @since @next
 */
export type Document = {
	readonly _tag: "Document";
	readonly kind: "change" | "release" | "history" | "upgrade" | "downgrade";
	readonly children: ReadonlyArray<Block>;
};

/**
 * Text, or inline nodes.
 *
 * @since @next
 */
export type InlineInput = string | Inline | ReadonlyArray<string | Inline>;

const isInline = (value: unknown): value is Inline =>
	Predicate.isTagged(value, "Text") ||
	Predicate.isTagged(value, "Code") ||
	Predicate.isTagged(value, "Link") ||
	Predicate.isTagged(value, "Strong") ||
	Predicate.isTagged(value, "Emphasis");

export const isBlock = (value: unknown): value is Block =>
	Predicate.isTagged(value, "Paragraph") ||
	Predicate.isTagged(value, "List") ||
	Predicate.isTagged(value, "CodeBlock") ||
	Predicate.isTagged(value, "Section");

const inlines = (value: InlineInput): ReadonlyArray<Inline> => {
	if (typeof value === "string") return [Text(value)];
	if (isInline(value)) return [value];

	return value.map((item) => (typeof item === "string" ? Text(item) : item));
};

/** @since @next */
export const Text = (value: string): Text => ({ _tag: "Text", value });
/** @since @next */
export const Code = (value: string): Code => ({ _tag: "Code", value });
/** @since @next */
export const Link = (text: InlineInput, url: string): Link => ({
	_tag: "Link",
	url,
	children: inlines(text),
});
/** @since @next */
export const Strong = (children: InlineInput): Strong => ({
	_tag: "Strong",
	children: inlines(children),
});
/** @since @next */
export const Emphasis = (children: InlineInput): Emphasis => ({
	_tag: "Emphasis",
	children: inlines(children),
});
/** @since @next */
export const Paragraph = (children: InlineInput): Paragraph => ({
	_tag: "Paragraph",
	children: inlines(children),
});
/** @since @next */
export const CodeBlock = (value: string, options: { readonly lang?: string } = {}): CodeBlock => ({
	_tag: "CodeBlock",
	value,
	lang: options.lang,
});

/**
 * Builds a list. Each item is text, an inline node, a block, or several blocks.
 *
 * @since @next
 */
export const List = (
	items: ReadonlyArray<string | Inline | Block | ReadonlyArray<Block>>,
	options: { readonly ordered?: boolean } = {},
): List => ({
	_tag: "List",
	ordered: options.ordered ?? false,
	items: items.map((item): ReadonlyArray<Block> => {
		if (typeof item === "string" || isInline(item)) return [Paragraph(item)];
		if (isBlock(item)) return [item];

		return item;
	}),
});

/**
 * An insertion point inside a plugin's scope.
 *
 * @since @next
 */
export type Anchor = {
	readonly _tag: "Anchor";
	readonly part: "title" | "body";
	readonly position: "pre" | "post";
};

const anchor = (part: Anchor["part"], position: Anchor["position"]): Anchor => ({
	_tag: "Anchor",
	part,
	position,
});

const makeTitle = (text: InlineInput, options: { readonly level?: number } = {}): Title =>
	pipeable({ _tag: "Title", children: inlines(text), level: options.level });

/**
 * Builds a title. `Document.Title.pre` and `Document.Title.post` are the insertion points
 * around a scoped section's title.
 *
 * @since @next
 */
export const Title = Object.assign(makeTitle, {
	pre: anchor("title", "pre"),
	post: anchor("title", "post"),
});

/**
 * The insertion points around a scoped section's body.
 *
 * @since @next
 */
export const Body = { pre: anchor("body", "pre"), post: anchor("body", "post") } as const;

const titleOf = (title: Title | string | undefined) =>
	typeof title === "string" ? makeTitle(title) : title;

/** @since @next */
export const Section = (
	id: string,
	options: { readonly title?: Title | string; readonly children?: ReadonlyArray<Block> } = {},
): Section =>
	pipeable({
		_tag: "Section",
		id,
		title: titleOf(options.title),
		before: [],
		after: [],
		children: options.children ?? [],
		release: undefined,
	});

/**
 * Sets an absolute heading level on a title. Levels outside 1 to 6 fail at render time.
 *
 * @since @next
 */
export const withLevel =
	(level: number) =>
	(title: Title): Title =>
		pipeable({ ...title, level });

/**
 * Sets the title of a section.
 *
 * @since @next
 */
export const withTitle =
	(title: Title | string) =>
	(section: Section): Section =>
		pipeable({ ...section, title: titleOf(title) });

/**
 * Appends blocks to a section's body.
 *
 * @since @next
 */
export const append =
	(...blocks: ReadonlyArray<Block>) =>
	(section: Section): Section =>
		pipeable({ ...section, children: [...section.children, ...blocks] });

/**
 * A document structure that cannot be rendered.
 *
 * @since @next
 */
export class DocumentError extends Data.TaggedError("DocumentError")<{
	readonly reason: "duplicate-section" | "heading-level";
	readonly message: string;
}> {}

// Plugins.

/**
 * Release-scoped plugins run once per included release.
 *
 * @since @next
 */
export const Release = "release";
/**
 * History-scoped plugins run once per history document.
 *
 * @since @next
 */
export const History = "history";

/** @since @next */
export type ReleaseContext<M> = {
	readonly package: Package;
	readonly version: Version;
	readonly metadata: M;
};

/** @since @next */
export type HistoryContext<M> = {
	readonly package: Package;
	readonly releases: ReadonlyArray<ReleaseContext<M>>;
};

/**
 * Plugin output: blocks to insert, or `null` for nothing.
 *
 * @since @next
 */
export type PluginOutput = Block | ReadonlyArray<Block> | null;

/** @since @next */
export type PluginOptions<M> =
	| {
			readonly scope: typeof Release;
			readonly at: Anchor;
			readonly resolve: (context: ReleaseContext<M>) => PluginOutput;
	  }
	| {
			readonly scope: typeof History;
			readonly at: Anchor;
			readonly resolve: (context: HistoryContext<M>) => PluginOutput;
	  };

/**
 * Contributes content at an insertion point. Plugins work on format-neutral content:
 * they must not fetch metadata or execute migrations. Output is inserted once and is not
 * processed by other plugins.
 *
 * @since @next
 */
export type Plugin<M> = { readonly _tag: "Plugin"; readonly id: string } & PluginOptions<M>;

/** @since @next */
export const makePlugin = <M>(id: string, options: PluginOptions<M>): Plugin<M> => ({
	_tag: "Plugin",
	id,
	...options,
});

/**
 * `Document.Plugin.make`
 *
 * @since @next
 */
export const Plugin = { make: makePlugin } as const;

// Lowering to mdast.

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
			return { type: "link", url: value.url, children: value.children.map(lowerInline) };
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
 * Resolves heading levels, checks section identifiers, and lowers a document to an
 * mdast root. Throws `DocumentError` for unsupported structure.
 *
 * @since @next
 */
export const toMdast = (document: Document): Mdast.Root => ({
	type: "root",
	children: lowerBlocks(document.children, 1, { ids: new Set(), label: "the document" }),
});
