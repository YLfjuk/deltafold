import type { Order, Result } from "effect";

/**
 * How version ids are read, written, and ordered. A scheme has no bumping or prerelease
 * rules; those belong to a `VersionStrategy`.
 *
 * @since @next
 */
export type VersionScheme<V> = {
	/** Shown in diagnostics, such as `"semver"`. */
	readonly name: string;
	/** Reads a version id. The message becomes an `InvalidVersion` issue. */
	readonly decode: (id: string) => Result.Result<V, string>;
	/** The canonical id written to history, file names, and manifests. */
	readonly encode: (version: V) => string;
	/** Precedence. The planner uses it only to refuse downgrades. */
	readonly order: Order.Order<V>;
};

/**
 * Declares a version scheme.
 *
 * @since @next
 */
export const make = <V>(scheme: VersionScheme<V>): VersionScheme<V> => scheme;
