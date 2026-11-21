import type { Plan, Files } from "../planning/release.ts";
import { join, type Location } from "./paths.ts";
import type { Snapshot } from "./resolve.ts";

export { apply } from "./apply.ts";
export { prepare } from "./prepare.ts";
export { resolve } from "./resolve.ts";
export type { ResolveOptions, Resolved, Snapshot, WithPrevious } from "./resolve.ts";

/**
 * A version module that the plan's previous version can be imported from when it was
 * not generated into the versions directory.
 *
 * @since 0.0.1
 */
export type PreviousSource = {
	readonly package: string;
	readonly version: string;
	/** Module path, relative to the release config file's directory. */
	readonly module: string;
	readonly exportName: string;
};

/**
 * File locations for a package directory. `manifest` is required: deltafold does not
 * assume a manifest name. `versions` defaults to `.deltafold/versions` inside `dir`.
 *
 * Apply also keeps `index.ts` in the versions directory. It exports the versions apply
 * generated, in release order, as `versions`. Earlier versions stay where they are, so the
 * package's history spreads the index after them once; `index: false` turns the index off.
 *
 * @example
 * ```ts
 * Release.make("widgets", {
 * 	packages: [{ package: widgets, files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }) }],
 * 	// ...
 * });
 *
 * // packages/widgets/src/package.ts
 * import { version as initial } from "../.deltafold/versions/1.5.2.ts";
 * import { versions } from "../.deltafold/versions/index.ts";
 *
 * export const widgets = Package.make("@acme/widgets", {
 * 	history: History.make({ versions: [initial, ...versions], migrations: [] }),
 * });
 * ```
 *
 * @since 0.0.1
 */
export const at = (
	dir: string,
	options: { readonly manifest: string; readonly versions?: string; readonly index?: boolean },
): Files => ({
	manifest: join(dir, options.manifest),
	versions: join(dir, options.versions ?? ".deltafold/versions"),
	...(options.index === undefined ? {} : { index: options.index }),
});

/** @since 0.0.1 */
export type PrepareOptions = Location & {
	/** Glob patterns of pending change modules, relative to the release config file's directory. */
	readonly pending: ReadonlyArray<string>;
	readonly previous?: ReadonlyArray<PreviousSource>;
	/** What `ReleaseFiles.resolve` read. Preparation refuses when any of it changed. */
	readonly snapshot?: Snapshot;
};

/**
 * One file operation. `before` is `null` for a new file; `after` is `null` for a removal.
 *
 * @since 0.0.1
 */
export type Edit = {
	readonly path: string;
	readonly before: string | null;
	readonly after: string | null;
};

/** @since 0.0.1 */
export type ReplacementReport = {
	readonly match: string;
	readonly versionOf: string;
	/** Absent when the package receives no version in this plan; nothing is replaced. */
	readonly version: string | undefined;
	readonly files: ReadonlyArray<{ readonly path: string; readonly occurrences: number }>;
	readonly zeroMatches: boolean;
};

/**
 * A reviewed set of local file edits. `reads` holds every file preparation depended on,
 * so `apply` can refuse when any of them changed.
 *
 * @since 0.0.1
 */
export type Prepared = {
	readonly _tag: "PreparedRelease";
	readonly plan: Plan;
	readonly edits: ReadonlyArray<Edit>;
	readonly replacements: ReadonlyArray<ReplacementReport>;
	/** Where the files are; apply uses the same location. */
	readonly location: Location;
	/** Every file preparation read, by workspace-relative path. */
	readonly reads: ReadonlyMap<string, string | null>;
	readonly globs: ReadonlyArray<{
		readonly pattern: ReadonlyArray<string>;
		readonly exclude: ReadonlyArray<string>;
		/** Paths matched but deliberately left out, such as pending modules. */
		readonly except: ReadonlyArray<string>;
		readonly matched: ReadonlyArray<string>;
	}>;
};

/** @since 0.0.1 */
export type Applied = {
	readonly written: ReadonlyArray<string>;
	readonly removed: ReadonlyArray<string>;
};
