import {
	Array as Arr,
	Effect,
	FileSystem,
	Order,
	Predicate,
	Struct,
	type PlatformError,
} from "effect";

import type { Requirement } from "./dependents-policy.ts";
import { issue, PrepareError, type Issue } from "./error.ts";
import type { Input, Release, Selection } from "./release.ts";
import { join } from "./source.ts";

/**
 * The files a resolution read, so that preparation and apply can refuse when any of them
 * changed afterwards.
 *
 * @since @next
 */
export type Snapshot = {
	readonly reads: ReadonlyMap<string, string>;
	readonly globs: ReadonlyArray<{
		readonly pattern: ReadonlyArray<string>;
		readonly matched: ReadonlyArray<string>;
	}>;
};

/** @since @next */
export type Resolved<M extends object> = { readonly input: Input<M>; readonly snapshot: Snapshot };

/**
 * One member's part of the input before resolution: its previous version comes from its
 * manifest.
 *
 * @since @next
 */
export type Unresolved<M extends object> = Omit<Selection<M>, "previous">;

/** @since @next */
export type ResolveOptions<M extends object> = Omit<Input<M>, "packages" | "requirements"> & {
	readonly packages: ReadonlyArray<Unresolved<M>>;
	/**
	 * Glob patterns of other manifests to scan for dependents outside the group. They are
	 * reported as cross-group requirements, never added.
	 */
	readonly manifests?: ReadonlyArray<string>;
};

const fields = [
	"dependencies",
	"peerDependencies",
	"optionalDependencies",
	"devDependencies",
] as const;

type Manifest = {
	readonly name: string | undefined;
	readonly version: string | undefined;
	readonly private: boolean;
	readonly ranges: ReadonlyArray<{
		readonly field: string;
		readonly dependency: string;
		readonly range: string;
	}>;
};

const readManifest = (text: string): Manifest | undefined => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Predicate.isObject(parsed)) return undefined;
	const record: { readonly [key: string]: unknown } = parsed;
	const ranges = fields.flatMap((field) => {
		const value = record[field];
		if (!Predicate.isObject(value)) return [];

		return Object.entries(value).flatMap(([dependency, range]) =>
			typeof range === "string" ? [{ field, dependency, range }] : [],
		);
	});

	return {
		name: typeof record.name === "string" ? record.name : undefined,
		version: typeof record.version === "string" ? record.version : undefined,
		private: record.private === true,
		ranges,
	};
};

/**
 * Resolves plan input from manifests. Each member's previous version is its manifest's
 * `version`, and dependency fields become requirements: `devDependencies` can get range
 * edits but never require a release. Nothing is written.
 *
 * @since @next
 */
export const resolve = <M extends object>(
	release: Release<M>,
	options: ResolveOptions<M>,
): Effect.Effect<Resolved<M>, PrepareError | PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const reads = new Map<string, string>();
		const issues: Array<Issue> = [];
		const members = release.config.packages.map((registration) => registration.package.name);
		const load = (path: string) =>
			Effect.gen(function* () {
				const key = join(path);
				if (!(yield* fs.exists(key))) return undefined;
				const text = yield* fs.readFileString(key);
				reads.set(key, text);

				return { path: key, manifest: readManifest(text) };
			});

		const packages: Array<Selection<M>> = [];
		const manifests: Array<{ readonly path: string; readonly manifest: Manifest }> = [];
		for (const selection of options.packages) {
			const name = selection.package.name;
			const path = release.config.packages.find(
				(registration) => registration.package.name === name,
			)?.files?.manifest;
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
			const matched = Arr.sort(
				[
					...new Set(
						(yield* Effect.forEach(options.manifests, (pattern) => fs.glob(pattern)))
							.flat()
							.map((path) => join(path)),
					),
				],
				Order.String,
			);
			globs.push({ pattern: options.manifests, matched });
			for (const path of matched) {
				if (manifests.some((entry) => entry.path === path)) continue;
				const loaded = yield* load(path);
				if (loaded?.manifest?.name === undefined) continue;
				manifests.push({ path, manifest: loaded.manifest });
			}
		}
		if (issues.length > 0) return yield* new PrepareError({ issues });

		const requirements: Array<Requirement> = manifests.flatMap(({ path, manifest }) =>
			manifest.ranges.flatMap(({ field, dependency, range }) =>
				members.includes(dependency) && manifest.name !== undefined
					? [
							{
								dependency,
								dependent: manifest.name,
								field,
								range,
								manifest: path,
								private: manifest.private,
							},
						]
					: [],
			),
		);
		const input: Input<M> = { ...Struct.omit(options, ["manifests"]), packages, requirements };

		return { input, snapshot: { reads, globs } };
	});
