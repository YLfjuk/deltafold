/**
 * Migrations are declared transitions between exact versions. Their tagged templates
 * keep prose and action occurrences as structured content.
 *
 * @packageDocumentation
 */
import { Predicate } from "effect";

import type * as Action from "./action.ts";
import { isAction, isParallel, isRef, isSequence } from "./action.ts";
import type { Change } from "./change.ts";
import { instruction, isInstruction, type Text } from "./instruction.ts";
import { describeValue, dedent, isScalar, type Scalar } from "./template.ts";
import type { Version } from "./version.ts";

export { instruction };
export type { Instruction, Prose, ProseValue, Text } from "./instruction.ts";

/**
 * Prose, mentions, and occurrence-declaring steps in template order.
 *
 * @since @next
 */
export type Content<A extends Action.Any = Action.Any> = ReadonlyArray<
	Text | Action.Ref | Action.Step<A>
>;

/**
 * Values accepted in migration templates.
 *
 * @since @next
 */
export type Interpolation = Scalar | Action.Ref | Action.Step;

/** @since @next */
export type Migration<A extends Action.Any = Action.Any> = {
	readonly _tag: "Migration";
	readonly id: string;
	readonly from: Version;
	readonly to: Version;
	/** The logical changes this transition handles. */
	readonly addresses: ReadonlyArray<Change>;
	/** Whether this is an explicit zero-work transition. */
	readonly noop: boolean;
	/** Author-declared cost, used only by the `lowest-cost` route policy. */
	readonly cost: number | undefined;
	readonly content: Content;
	/** The reverse transition, from `to` back to `from`. Absent means no reverse edge. */
	readonly revert: Content | undefined;
	/** Type-level record of the action instances in `content` and `revert`. */
	readonly "~actions"?: A;
};

/**
 * Any migration.
 *
 * @since @next
 */
export type Any = Migration<any>;

/**
 * The action instances a migration can contribute to a plan.
 *
 * @since @next
 */
export type ActionsOf<M> = M extends Migration<infer A> ? A : never;

/** @since @next */
export type Options = {
	readonly from: Version;
	readonly to: Version;
	readonly addresses?: ReadonlyArray<Change>;
	readonly cost?: number;
};

/** @since @next */
export const isMigration = (value: unknown): value is Any => Predicate.isTagged(value, "Migration");

const isStep = (value: unknown): value is Action.Step =>
	isAction(value) || isInstruction(value) || isSequence(value) || isParallel(value);

const validateStep = (step: Action.Step, context: string): void => {
	if (isSequence(step)) {
		for (const child of step.children) checkStep(child, context);

		return;
	}
	if (isParallel(step)) {
		for (const branch of step.branches) checkStep(branch, context);
	}
};

const checkStep = (value: unknown, context: string): void => {
	if (!isStep(value)) {
		throw new TypeError(
			`${context}: a group can only contain actions, instructions, and groups.`,
		);
	}
	validateStep(value, context);
};

/** Builds content from a tagged template. */
const content = (
	strings: ReadonlyArray<string>,
	values: ReadonlyArray<unknown>,
	context: string,
): Content => {
	const literals = dedent(strings);
	const result: Array<Text | Action.Ref | Action.Step> = [];

	const pushText = (text: string) => {
		if (text === "") return;

		const last = result.at(-1);
		if (last?._tag === "Text") {
			result[result.length - 1] = { _tag: "Text", text: last.text + text };

			return;
		}
		result.push({ _tag: "Text", text });
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
			result.push(value);
			continue;
		}
		if (isStep(value)) {
			validateStep(value, context);
			result.push(value);
			continue;
		}
		throw new TypeError(`${context}: cannot interpolate ${describeValue(value)}.`);
	}

	return result;
};

/**
 * Declares a migration between exact versions. Interpolated actions, instruction blocks,
 * and groups declare occurrences; `Action.ref` only mentions an action.
 *
 * @example
 * ```ts
 * const migrate152To200 = Migration.make("1.5.2-to-2.0.0", {
 * 	from: v152,
 * 	to: v200,
 * 	addresses: [timeoutRenamed],
 * })`
 * 	Update the configuration for export A:
 *
 * 	${renameExportA}
 * `;
 * ```
 *
 * @since @next
 */
export const make =
	(id: string, options: Options) =>
	<const V extends ReadonlyArray<Interpolation>>(
		strings: TemplateStringsArray,
		...values: V
	): Migration<Action.ActionsOf<V[number]>> => ({
		_tag: "Migration",
		id,
		from: options.from,
		to: options.to,
		addresses: options.addresses ?? [],
		noop: false,
		cost: options.cost,
		content: content(strings, values, `Migration "${id}"`),
		revert: undefined,
	});

/** @since @next */
export type NoopOptions = Options & {
	/** Also declares the reverse transition as zero-work. */
	readonly reversible?: boolean;
};

/**
 * Declares a supported transition that requires no consumer work. It is a directed edge
 * like any migration. Do not use it to hide missing support for changes that need
 * instructions.
 *
 * @since @next
 */
export const noop = (id: string, options: NoopOptions): Migration<never> => ({
	_tag: "Migration",
	id,
	from: options.from,
	to: options.to,
	addresses: options.addresses ?? [],
	noop: true,
	cost: options.cost,
	content: [],
	revert: options.reversible === true ? [] : undefined,
});

/**
 * Adds a reverse transition. Register the returned migration in place of the original:
 * both share the same identifier.
 *
 * @example
 * ```ts
 * const reversible = Migration.withRevert(migrate152To200)`
 * 	Restore the previous configuration:
 *
 * 	${restoreTimeout}
 * `;
 * ```
 *
 * @since @next
 */
export const withRevert =
	<A extends Action.Any>(migration: Migration<A>) =>
	<const V extends ReadonlyArray<Interpolation>>(
		strings: TemplateStringsArray,
		...values: V
	): Migration<A | Action.ActionsOf<V[number]>> => ({
		...migration,
		revert: content(strings, values, `Revert of migration "${migration.id}"`),
	});
