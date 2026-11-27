import { Predicate } from "effect";

import { describeValue, dedent, isScalar } from "./template.ts";
import type { Scalar } from "./template.ts";

/** @since 0.0.1 */
export type Metadata = { readonly [field: string]: unknown };

/** @since 0.0.1 */
export type NoMetadata = { readonly [field: string]: undefined };

/**
 * A human-readable record of one logical change. A change can exist before it is
 * assigned to a release, and it does not need an executable migration.
 *
 * deltafold does not interpret `metadata`. Consumers choose its fields, such as a
 * classification or a breaking flag, and what they mean.
 *
 * @since 0.0.1
 */
export type Change<M extends object = Metadata> = {
	readonly _tag: "Change";
	/** Stable identifier. Editing the description does not change identity. */
	readonly id: string;
	readonly metadata: M;
	readonly description: string;
	/** Historical relationship only: it does not cancel actions or create routes. */
	readonly reverts: ReadonlyArray<Any>;
	/** The change that an adapted backport was derived from. */
	readonly backportOf: Any | undefined;
};

/** @since 0.0.1 */
export type Any = Change<object>;

/** @since 0.0.1 */
export type Relations = {
	readonly reverts?: ReadonlyArray<Any>;
	readonly backportOf?: Any;
};

/** @since 0.0.1 */
export type Describe<M extends object> = (
	strings: TemplateStringsArray,
	...values: ReadonlyArray<Scalar>
) => Change<M>;

const describe =
	<M extends object>(id: string, metadata: M, relations: Relations): Describe<M> =>
	(strings, ...values) => {
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
			metadata,
			description,
			reverts: relations.reverts ?? [],
			backportOf: relations.backportOf,
		};
	};

/**
 * @example
 * ```ts
 * const retriesAdded = Change.make("2026-11-20.add-retries")`
 * 	Add a retry limit option.
 * `;
 * const timeoutRenamed = Change.make("2026-11-06.rename-timeout", { breaking: true })`
 * 	Rename the timeout configuration option to requestTimeout.
 * `;
 * ```
 *
 * @since 0.0.1
 */
export function make(id: string): Describe<NoMetadata>;
export function make<const M extends object>(
	id: string,
	metadata: M,
	relations?: Relations,
): Describe<M>;
export function make(id: string, metadata: object = {}, relations: Relations = {}) {
	return describe(id, metadata, relations);
}

/** @since 0.0.1 */
export type Definition<M extends object> = {
	readonly make: (id: string, metadata: M, relations?: Relations) => Describe<M>;
};

/**
 * @example
 * ```ts
 * const ConfigChange = Change.define<{
 * 	readonly kind: "added" | "changed" | "fixed";
 * 	readonly breaking: boolean;
 * }>();
 * const timeoutRenamed = ConfigChange.make("2026-11-06.rename-timeout", {
 * 	kind: "changed",
 * 	breaking: true,
 * })`
 * 	Rename the timeout configuration option to requestTimeout.
 * `;
 * ```
 *
 * @since 0.0.1
 */
export const define = <M extends object>(): Definition<M> => ({ make: make<M> });

/** @since 0.0.1 */
export const isChange = (value: unknown): value is Change => Predicate.isTagged(value, "Change");
