/**
 * Renders documents as Markdown through mdast-util-to-markdown, which handles
 * formatting and escaping.
 *
 * @packageDocumentation
 */
import { toMarkdown } from "mdast-util-to-markdown";

import { toMdast, type Document } from "./changelog/document.ts";

/** Renders a document as Markdown. Throws `DocumentError` for unsupported structure. */
export const render = (document: Document): string =>
	toMarkdown(toMdast(document), { bullet: "-", emphasis: "_", strong: "*" });
