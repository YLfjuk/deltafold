import type { Order, Result } from "effect";

/**
 * Has no bumping or prerelease rules; those belong to a `VersionStrategy`.
 *
 * @since 0.0.1
 */
export type VersionScheme<V> = {
	/** Shown in diagnostics, such as `"semver"`. */
	readonly name: string;
	/** Failure messages become `InvalidVersion` issues. */
	readonly decode: (id: string) => Result.Result<V, string>;
	/** The canonical id written to history, file names, and manifests. */
	readonly encode: (version: V) => string;
	/** Used by the planner only to refuse downgrades. */
	readonly order: Order.Order<V>;
};

/** @since 0.0.1 */
export const make = <V>(scheme: VersionScheme<V>): VersionScheme<V> => scheme;
