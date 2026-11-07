/**
 * Changes are human-readable records of logical changes. A change can exist before it is
 * assigned to a release, and does not require an executable migration.
 *
 * @packageDocumentation
 */
import { Predicate } from "effect";

import { describeValue, dedent, isScalar, type Scalar } from "./internal/template.ts";

/** Change classifications. Breaking status is recorded separately. */
export const Kind = {
	Added: "added",
	Changed: "changed",
	Removed: "removed",
	Fixed: "fixed",
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];

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

export const isChange = (value: unknown): value is Change => Predicate.isTagged(value, "Change");

/** Whether two definitions with the same identifier describe the same change. */
export const sameDefinition = (self: Change, that: Change): boolean =>
	self === that ||
	(self.id === that.id &&
		self.kind === that.kind &&
		self.breaking === that.breaking &&
		self.description === that.description &&
		self.backportOf?.id === that.backportOf?.id &&
		self.reverts.length === that.reverts.length &&
		self.reverts.every((change, index) => change.id === that.reverts[index]?.id));
