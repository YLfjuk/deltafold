import { Predicate } from "effect";

import type { ValueOf } from "../types.ts";
import { describeValue, dedent, isScalar, type Scalar } from "./template.ts";

/**
 * Change classifications. Breaking status is recorded separately.
 *
 * @since @next
 */
export const Kind = {
	Added: "added",
	Changed: "changed",
	Removed: "removed",
	Fixed: "fixed",
} as const;

/** @since @next */
export type Kind = ValueOf<typeof Kind>;

/**
 * A human-readable record of one logical change. A change can exist before it is
 * assigned to a release, and it does not need an executable migration.
 *
 * @since @next
 */
export type Change = {
	readonly _tag: "Change";
	/** Stable identifier. Editing the description does not change identity. */
	readonly id: string;
	readonly kind: Kind;
	readonly breaking: boolean;
	readonly description: string;
	/** Historical relationship only: it does not cancel actions or create routes. */
	readonly reverts: ReadonlyArray<Change>;
	/** The change that an adapted backport was derived from. */
	readonly backportOf: Change | undefined;
};

/** @since @next */
export type Options = {
	readonly kind: Kind;
	readonly breaking?: boolean;
	readonly reverts?: ReadonlyArray<Change>;
	readonly backportOf?: Change;
};

/**
 * Declares a change. The tagged template is its description.
 *
 * @example
 * ```ts
 * const timeoutRenamed = Change.make("2026-11-06.rename-timeout", {
 * 	kind: "changed",
 * 	breaking: true,
 * })`
 * 	Rename the timeout configuration option to requestTimeout.
 * `;
 * ```
 *
 * @since @next
 */
export const make =
	(id: string, options: Options) =>
	(strings: TemplateStringsArray, ...values: ReadonlyArray<Scalar>): Change => {
		const literals = dedent(strings);
		let description = "";
		for (const [index, literal] of literals.entries()) {
			description += literal;
			if (index >= values.length) continue;

			const value: unknown = values[index];
			if (!isScalar(value)) {
				throw new TypeError(`Change "${id}": cannot interpolate ${describeValue(value)}.`);
			}
			description += String(value);
		}

		return {
			_tag: "Change",
			id,
			kind: options.kind,
			breaking: options.breaking ?? false,
			description,
			reverts: options.reverts ?? [],
			backportOf: options.backportOf,
		};
	};

/** @since @next */
export const isChange = (value: unknown): value is Change => Predicate.isTagged(value, "Change");
