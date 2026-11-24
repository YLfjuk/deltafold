import { toHtml } from "hast-util-to-html";
import { toHast } from "mdast-util-to-hast";

import type { Document } from "../document.ts";
import { toMdast } from "./mdast.ts";

/**
 * Renders a document as an HTML fragment. Throws `DocumentError` for unsupported structure.
 *
 * @since 0.0.1
 */
export const render = (document: Document): string => toHtml(toHast(toMdast(document)));
