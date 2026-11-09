import { toHtml } from "hast-util-to-html";
import { toHast } from "mdast-util-to-hast";

import type { Document } from "../features/documents/document.ts";
import { toMdast } from "./mdast.ts";

/**
 * Renders a document as an HTML fragment. Throws `DocumentError` for unsupported structure.
 *
 * @since @next
 */
export const render = (document: Document): string => toHtml(toHast(toMdast(document)));
