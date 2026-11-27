import { Array as Arr, Order } from "effect";
import type { Node, SourceFile } from "typescript-7.1/ast";
import { SyntaxKind } from "typescript-7.1/ast";
import { skipTrivia } from "typescript-7.1/ast/scanner";

import { EditRejected } from "./errors.ts";

/**
 * Offsets are UTF-16 positions in `SourceFile.text`, which has no byte order mark.
 *
 * @since @next
 */
export type TextEdit = {
	readonly pos: number;
	readonly end: number;
	readonly newText: string;
};

/**
 * `path` is root-relative and `/`-separated.
 *
 * @since @next
 */
export type FileEdit = TextEdit & { readonly path: string };

/**
 * Edits start at a node's first token, after its leading comments and whitespace.
 *
 * @since @next
 */
export type Edits = {
	readonly replace: (node: Node, text: string) => FileEdit;
	/** Keeps the node's leading comments and whitespace. */
	readonly remove: (node: Node) => FileEdit;
	readonly insertBefore: (node: Node, text: string) => FileEdit;
	readonly insertAfter: (node: Node, text: string) => FileEdit;
	/**
	 * Shorthand forms keep the local name, so `const { a1 } = value` becomes
	 * `const { a2: a1 } = value`. String-literal names keep their quotes, so pass
	 * `newName` unquoted. Throws `EditRejected` for the `"other"` `NameForm`.
	 */
	readonly rename: (name: Node, newName: string) => FileEdit;
	/** Excludes leading comments and whitespace. */
	readonly text: (node: Node) => string;
};

/** @since @next */
export type NameForm =
	| "access"
	| "element-access"
	| "property"
	| "shorthand-property"
	| "shorthand-binding"
	| "declaration"
	| "string"
	| "other";

const sourceFileOf = (node: Node): SourceFile => {
	let current: Node | undefined = node;
	while (current !== undefined && current.kind !== SyntaxKind.SourceFile)
		current = current.parent;
	if (current === undefined) {
		throw new TypeError("The node is not attached to a source file");
	}

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The loop stopped at a SourceFile node.
	return current as SourceFile;
};

const sameNode = (a: Node | undefined, b: Node) =>
	a !== undefined && a.pos === b.pos && a.end === b.end && a.kind === b.kind;

const memberKinds = new Set<SyntaxKind>([
	SyntaxKind.PropertySignature,
	SyntaxKind.PropertyDeclaration,
	SyntaxKind.MethodSignature,
	SyntaxKind.MethodDeclaration,
	SyntaxKind.GetAccessor,
	SyntaxKind.SetAccessor,
	SyntaxKind.EnumMember,
]);

export const nameForm = (name: Node): NameForm => {
	const parent = name.parent;
	if (parent === undefined) return "other";
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Optional properties of specific node kinds are read by kind below.
	const fields = parent as Node & {
		readonly name?: Node;
		readonly propertyName?: Node;
		readonly argumentExpression?: Node;
	};

	switch (parent.kind) {
		case SyntaxKind.PropertyAccessExpression:
			return sameNode(fields.name, name) ? "access" : "other";
		case SyntaxKind.ElementAccessExpression:
			return name.kind === SyntaxKind.StringLiteral &&
				sameNode(fields.argumentExpression, name)
				? "element-access"
				: "other";
		case SyntaxKind.ShorthandPropertyAssignment:
			return sameNode(fields.name, name) ? "shorthand-property" : "other";
		case SyntaxKind.BindingElement:
			if (sameNode(fields.propertyName, name)) return "property";

			return fields.propertyName === undefined && sameNode(fields.name, name)
				? "shorthand-binding"
				: "other";
		case SyntaxKind.PropertyAssignment:
			return sameNode(fields.name, name) ? "property" : "other";
		default:
			if (memberKinds.has(parent.kind) && sameNode(fields.name, name)) return "declaration";

			return name.kind === SyntaxKind.StringLiteral ? "string" : "other";
	}
};

/**
 * `pathOf` returns the root-relative path of a source file the transform may edit, and
 * throws `EditRejected` for any other file.
 */
export const makeEdits = (pathOf: (sourceFile: SourceFile) => string): Edits => {
	const locate = (node: Node) => {
		const sourceFile = sourceFileOf(node);
		const path = pathOf(sourceFile);
		const start = skipTrivia(sourceFile.text, node.pos);

		return { path, start, text: sourceFile.text };
	};

	const replace = (node: Node, newText: string): FileEdit => {
		const { path, start } = locate(node);

		return { path, pos: start, end: node.end, newText };
	};

	return {
		replace,
		remove: (node) => replace(node, ""),
		insertBefore: (node, newText) => {
			const { path, start } = locate(node);

			return { path, pos: start, end: start, newText };
		},
		insertAfter: (node, newText) => {
			const { path } = locate(node);

			return { path, pos: node.end, end: node.end, newText };
		},
		rename: (name, newName) => {
			const { path, start, text } = locate(name);
			const form = nameForm(name);
			const isString = name.kind === SyntaxKind.StringLiteral;
			if (form === "other" || (!isString && name.kind !== SyntaxKind.Identifier)) {
				throw new EditRejected({
					path,
					reason: `rename does not support a ${SyntaxKind[name.kind]} in a ${SyntaxKind[name.parent?.kind ?? SyntaxKind.Unknown]}`,
					ranges: [{ pos: start, end: name.end }],
				});
			}
			if (isString) return { path, pos: start + 1, end: name.end - 1, newText: newName };
			if (form === "shorthand-property" || form === "shorthand-binding") {
				return {
					path,
					pos: start,
					end: name.end,
					newText: `${newName}: ${text.slice(start, name.end)}`,
				};
			}

			return { path, pos: start, end: name.end, newText: newName };
		},
		text: (node) => {
			const { start, text } = locate(node);

			return text.slice(start, node.end);
		},
	};
};

const isInsertion = (edit: TextEdit) => edit.pos === edit.end;

const byOffset = Order.combine(
	Order.mapInput(Order.Number, (edit: TextEdit) => edit.pos),
	Order.mapInput(Order.Number, (edit: TextEdit) => (isInsertion(edit) ? 0 : 1)),
);

const sameEdit = (a: TextEdit, b: TextEdit) =>
	a.pos === b.pos && a.end === b.end && a.newText === b.newText;

/**
 * Keeps one copy of identical replacements and removals, and every insertion. At one
 * offset, insertions come before a replacement, in the order returned. An edit outside
 * the text, or two overlapping edits, rejects the batch.
 */
export const applyEdits = (
	path: string,
	text: string,
	edits: ReadonlyArray<TextEdit>,
): string | EditRejected => {
	const unique: Array<TextEdit> = [];
	for (const edit of edits) {
		const valid =
			Number.isInteger(edit.pos) &&
			Number.isInteger(edit.end) &&
			edit.pos >= 0 &&
			edit.pos <= edit.end &&
			edit.end <= text.length &&
			typeof edit.newText === "string";
		if (!valid) {
			return new EditRejected({
				path,
				reason: `The edit from ${edit.pos} to ${edit.end} is outside the text of length ${text.length}`,
				ranges: [{ pos: edit.pos, end: edit.end }],
			});
		}
		if (!isInsertion(edit) && unique.some((kept) => sameEdit(kept, edit))) continue;
		unique.push(edit);
	}

	// The sort is stable, so insertions at one offset keep their returned order.
	const sorted = Arr.sort(unique, byOffset);

	let output = "";
	let cursor = 0;
	let previous: TextEdit | undefined;
	for (const edit of sorted) {
		if (previous !== undefined && edit.pos < previous.end) {
			return new EditRejected({
				path,
				reason: `The edits from ${previous.pos} to ${previous.end} and from ${edit.pos} to ${edit.end} overlap`,
				ranges: [
					{ pos: previous.pos, end: previous.end },
					{ pos: edit.pos, end: edit.end },
				],
			});
		}
		output += text.slice(cursor, edit.pos) + edit.newText;
		cursor = edit.end;
		if (!isInsertion(edit) || previous === undefined || previous.end < edit.end)
			previous = edit;
	}

	return output + text.slice(cursor);
};

const byteOrderMark = "﻿";

export const splitByteOrderMark = (raw: string) =>
	raw.startsWith(byteOrderMark)
		? { bom: byteOrderMark, text: raw.slice(1) }
		: { bom: "", text: raw };
