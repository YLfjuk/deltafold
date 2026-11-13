import { Predicate } from "effect";

import { describeValue, dedent, isScalar, type Scalar } from "./template.ts";

/**
 * The metadata of a change whose shape is not known statically. Reading a field gives
 * `unknown`.
 *
 * @since @next
 */
export type Metadata = { readonly [field: string]: unknown };

/**
 * The metadata of a change declared without any.
 *
 * @since @next
 */
export type NoMetadata = { readonly [field: string]: never };

/**
 * A human-readable record of one logical change. A change can exist before it is
 * assigned to a release, and it does not need an executable migration.
 *
 * deltafold does not interpret `metadata`. Consumers choose its fields, such as a
 * classification or a breaking flag, and what they mean.
 *
 * @since @next
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

/**
 * A change with any metadata.
 *
 * @since @next
 */
export type Any = Change<any>;

/**
 * Relationships to other changes.
 *
 * @since @next
 */
export type Relations = {
	readonly reverts?: ReadonlyArray<Any>;
	readonly backportOf?: Any;
};

/**
 * Takes the description as a tagged template and returns the change.
 *
 * @since @next
 */
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
 * Declares a change. The tagged template is its description. Metadata is optional, and
 * its type is inferred from the value, literals included.
 *
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
 * @since @next
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

/**
 * Makes changes that share one metadata shape.
 *
 * @since @next
 */
export type Definition<M extends object> = {
	readonly make: (id: string, metadata: M, relations?: Relations) => Describe<M>;
};

/**
 * Defines a reusable change factory whose metadata must have the type `M`.
 *
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
 * @since @next
 */
export const define = <M extends object>(): Definition<M> => ({ make: make<M> });

/** @since @next */
export const isChange = (value: unknown): value is Change => Predicate.isTagged(value, "Change");
