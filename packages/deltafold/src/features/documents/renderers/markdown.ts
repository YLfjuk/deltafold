import { toMarkdown } from "mdast-util-to-markdown";

import type { Document } from "../document.ts";
import { toMdast } from "./mdast.ts";

/**
 * Renders a document as Markdown. Throws `DocumentError` for unsupported structure.
 *
 * @since 0.0.1
 */
export const render = (document: Document): string =>
	toMarkdown(toMdast(document), { bullet: "-", emphasis: "_", strong: "*" });
