import { Effect, FileSystem, Struct } from "effect";
import type { PlatformError } from "effect";

import { Package } from "deltafold";
import { issue, PrepareError } from "../../foundation/error.ts";
import type { Issue } from "../../foundation/error.ts";
import { readManifest } from "../../foundation/npm/index.ts";
import type { Manifest } from "../../foundation/npm/index.ts";
import type { DependentsPolicy, Release } from "../planning/index.ts";
import { globAll } from "./glob.ts";
import { paths } from "./paths.ts";
import type { Location } from "./paths.ts";

/**
 * The files a resolution read, so that preparation and apply can refuse when any of them
 * changed afterwards.
 *
 * @since 0.0.1
 */
export type Snapshot = {
	readonly reads: ReadonlyMap<string, string>;
	readonly globs: ReadonlyArray<{
		readonly pattern: ReadonlyArray<string>;
		readonly matched: ReadonlyArray<string>;
	}>;
};

/**
 * A plan entry after resolution: its previous version is the manifest's version.
 *
 * @since 0.0.1
 */
export type WithPrevious<E> =
	E extends Package.Package<any>
		? { readonly package: E; readonly previous: string; readonly changes: ReadonlyArray<never> }
		: Omit<E, "previous"> & { readonly previous: string };

/** @since 0.0.1 */
export type Resolved<
	M extends object,
	V,
	I,
	D,
	_Rs extends ReadonlyArray<Release.Registration<M>>,
	Ps extends ReadonlyArray<unknown>,
> = {
	/** Every member with its manifest version as a stated `previous`. */
	readonly input: Release.Options<M, V, I, D> & {
		readonly packages: { readonly [K in keyof Ps]: WithPrevious<Ps[K]> };
		readonly requirements: ReadonlyArray<DependentsPolicy.Requirement>;
	};
	readonly snapshot: Snapshot;
};

/**
 * Resolution options: plan input whose previous versions and requirements come from
 * manifests.
 *
 * @since 0.0.1
 */
export type ResolveOptions<
	M extends object,
	V,
	I,
	D,
	Rs extends ReadonlyArray<Release.Registration<M>>,
	Ps extends ReadonlyArray<unknown>,
> = Location &
	Release.Options<M, V, I, D> & {
		readonly packages: Release.Packages<M, V, I, D, Rs, Ps>;
		/**
		 * Glob patterns of other manifests to scan for dependents outside the group. They are
		 * reported as cross-group requirements, never added.
		 */
		readonly manifests?: ReadonlyArray<string>;
	};

/**
 * Resolves plan input from manifests. Each member's previous version is its manifest's
 * `version`, and dependency fields become requirements: `devDependencies` can get range
 * edits but never require a release. Nothing is written.
 *
 * @since 0.0.1
 */
export const resolve = <
	M extends object,
	V,
	I,
	D,
	Rs extends ReadonlyArray<Release.Registration<M>>,
	const Ps extends ReadonlyArray<Release.Entry<Rs>>,
>(
	release: Release.Release<M, V, I, D, Rs>,
	options: ResolveOptions<M, V, I, D, Rs, Ps>,
): Effect.Effect<
	Resolved<M, V, I, D, Rs, Ps>,
	PrepareError | PlatformError.PlatformError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const location = paths(options);
		const reads = new Map<string, string>();
		const issues: Array<Issue> = [];
		const fromBase = (path: string): string | undefined => {
			const resolved = location.fromBase(path);
			if (typeof resolved === "string") return resolved;
			issues.push(resolved);
			return undefined;
		};
		const members = release.config.packages.map((registration) => registration.package.name);
		const load = (key: string) =>
			Effect.gen(function* () {
				const fsPath = location.toFs(key);
				if (!(yield* fs.exists(fsPath))) return undefined;
				const text = yield* fs.readFileString(fsPath);
				reads.set(key, text);

				return { path: key, manifest: readManifest(text) };
			});

		const packages: Array<{
			readonly package: Package.Package<any>;
			readonly previous: string;
		}> = [];
		const manifests: Array<{ readonly path: string; readonly manifest: Manifest }> = [];
		for (const member of options.packages as ReadonlyArray<unknown>) {
			// Entries are bare packages or selections; the public types check them.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			const selection = (
				Package.isPackage(member) ? { package: member, changes: [] } : member
			) as { readonly package: Package.Package<any> };
			const name = selection.package.name;
			const configured = release.config.packages.find(
				(registration) => registration.package.name === name,
			)?.files.manifest;
			const path = configured === undefined ? undefined : fromBase(configured);
			const loaded = path === undefined ? undefined : yield* load(path);
			const manifest = loaded?.manifest;
			if (
				loaded === undefined ||
				manifest === undefined ||
				manifest.name !== name ||
				manifest.version === undefined
			) {
				issues.push(
					issue(
						"ManifestMismatch",
						`${path ?? name}: expected a manifest named ${name} with a version field.`,
						[path ?? name],
					),
				);
				continue;
			}
			packages.push({ ...selection, previous: manifest.version });
			manifests.push({ path: loaded.path, manifest });
		}

		const globs: Array<Snapshot["globs"][number]> = [];
		if (options.manifests !== undefined) {
			const patterns = options.manifests.flatMap((pattern) => fromBase(pattern) ?? []);
			const matched = yield* globAll(fs, location, patterns, []);
			globs.push({ pattern: patterns, matched });
			for (const path of matched) {
				if (manifests.some((entry) => entry.path === path)) continue;
				const loaded = yield* load(path);
				if (loaded?.manifest?.name === undefined) continue;
				manifests.push({ path, manifest: loaded.manifest });
			}
		}
		if (issues.length > 0) return yield* new PrepareError({ issues });

		const requirements: Array<DependentsPolicy.Requirement> = manifests.flatMap(
			({ path, manifest }) =>
				manifest.ranges.flatMap(({ field, dependency, range }) =>
					members.includes(dependency) && manifest.name !== undefined
						? {
								dependency,
								dependent: manifest.name,
								field,
								range,
								manifest: path,
								private: manifest.private,
							}
						: [],
				),
		);
		// Each entry keeps its own fields, with the manifest's version as `previous`.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const input = {
			...Struct.omit(options, ["manifests", "root", "base"]),
			packages,
			requirements,
		} as unknown as Resolved<M, V, I, D, Rs, Ps>["input"];

		return { input, snapshot: { reads, globs } };
	});
