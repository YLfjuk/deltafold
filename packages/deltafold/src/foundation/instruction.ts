import { Predicate } from "effect";

import type * as Action from "./action.ts";
import { isAction, isRef } from "./action.ts";
import { describeValue, dedent, isScalar } from "./template.ts";
import type { Scalar } from "./template.ts";

/** @since 0.0.1 */
export type Text = {
	readonly _tag: "Text";
	readonly text: string;
};

/** @since 0.0.1 */
export type Prose = ReadonlyArray<Text | Action.Ref>;

/** @since 0.0.1 */
export type ProseValue = Scalar | Action.Ref;

/**
 * Declares an occurrence of `action`; when optimization removes the action, `content`
 * leaves the resolved guide with it.
 *
 * @since 0.0.1
 */
export type Instruction<A extends Action.Any = Action.Any> = {
	readonly _tag: "Instruction";
	readonly action: A;
	readonly content: Prose;
};

export const isInstruction = (value: unknown): value is Instruction =>
	Predicate.isTagged(value, "Instruction");

/** Throws `TypeError` on values other than scalars and `Action.Ref` mentions. */
export const prose = (
	strings: ReadonlyArray<string>,
	values: ReadonlyArray<unknown>,
	context: string,
): Prose => {
	const literals = dedent(strings);
	const content: Array<Text | Action.Ref> = [];

	const pushText = (text: string) => {
		if (text === "") return;

		const last = content.at(-1);
		if (last?._tag === "Text") {
			content[content.length - 1] = { _tag: "Text", text: last.text + text };

			return;
		}
		content.push({ _tag: "Text", text });
	};

	for (const [index, literal] of literals.entries()) {
		pushText(literal);
		if (index >= values.length) continue;

		const value = values[index];
		if (isScalar(value)) {
			pushText(String(value));
			continue;
		}
		if (isRef(value)) {
			content.push(value);
			continue;
		}
		if (isAction(value)) {
			throw new TypeError(
				`${context}: action "${value.id}" cannot be interpolated here because it would declare another occurrence. Use Action.ref(action) to mention it.`,
			);
		}
		throw new TypeError(`${context}: cannot interpolate ${describeValue(value)}.`);
	}

	return content;
};

/**
 * @example
 * ```ts
 * Migration.instruction(renameTimeout)`
 * 	Rename the timeout option, keeping its existing value.
 * `;
 * ```
 *
 * @since 0.0.1
 */
export const instruction =
	<A extends Action.Any>(action: A) =>
	(strings: TemplateStringsArray, ...values: ReadonlyArray<ProseValue>): Instruction<A> => ({
		_tag: "Instruction",
		action,
		content: prose(strings, values, `Instruction for "${action.id}"`),
	});
