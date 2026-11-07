/**
 * Versions record release membership and ancestry. Several versions can descend from
 * the same predecessor; declaration order and semver order do not change ancestry.
 *
 * @packageDocumentation
 */
import { Predicate } from "effect";

import type { Change } from "./change.ts";

/** @since @next */
export type Version = {
	readonly _tag: "Version";
	readonly id: string;
	/** The release this version descends from. Absent for a root such as `0.0.0`. */
	readonly previous: Version | undefined;
	/** The changes that shipped in this release. */
	readonly changes: ReadonlyArray<Change>;
};

/** @since @next */
export type Options = {
	readonly previous?: Version;
	readonly changes: ReadonlyArray<Change>;
};

/**
 * Declares a version.
 *
 * @example
 * ```ts
 * const v0 = Version.make("0.0.0", { changes: [] });
 * const v100 = Version.make("1.0.0", { previous: v0, changes: [timeoutRenamed] });
 * ```
 *
 * @since @next
 */
export const make = (id: string, options: Options): Version => ({
	_tag: "Version",
	id,
	previous: options.previous,
	changes: options.changes,
});

/** @since @next */
export const isVersion = (value: unknown): value is Version => Predicate.isTagged(value, "Version");

/**
 * Release metadata attached to a version by release tooling. It does not modify the
 * version registered in history.
 *
 * @since @next
 */
export type Release<M> = {
	readonly _tag: "Release";
	readonly version: Version;
	readonly metadata: M;
};

/**
 * Annotates a version with release metadata.
 *
 * @example
 * ```ts
 * export const release200 = Version.withMetadata(v200, {
 * 	releasedAt: "2026-11-06T12:00:00Z",
 * 	commit: "abc123",
 * });
 * ```
 *
 * @since @next
 */
export const withMetadata = <const M>(version: Version, metadata: M): Release<M> => ({
	_tag: "Release",
	version,
	metadata,
});
