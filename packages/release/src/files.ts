import { Array as Arr, Effect, FileSystem, Order, type PlatformError } from "effect";

import {
	ApplyFailed,
	ChangedDuringApply,
	issue,
	PrepareError,
	StalePlan,
	type Issue,
} from "./error.ts";
import { paths, type Location, type Paths } from "./paths.ts";
import type { Plan, PlannedVersion, Replacement } from "./release.ts";
import type { Files } from "./release.ts";
import type { Snapshot } from "./resolve.ts";
import { dirname, join, relative, render, scan, type Declaration } from "./source.ts";

export { resolve } from "./resolve.ts";
export type { ResolveOptions, Resolved, Snapshot, WithPrevious } from "./resolve.ts";

/**
 * A version module that the plan's previous version can be imported from when it was
 * not generated into the versions directory.
 *
 * @since @next
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
 * @example
 * ```ts
 * Release.make("widgets", {
 * 	packages: [{ package: widgets, files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }) }],
 * 	// ...
 * });
 * ```
 *
 * @since @next
 */
export const at = (
	dir: string,
	options: { readonly manifest: string; readonly versions?: string },
): Files => ({
	manifest: join(dir, options.manifest),
	versions: join(dir, options.versions ?? ".deltafold/versions"),
});

/** @since @next */
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
 * @since @next
 */
export type Edit = {
	readonly path: string;
	readonly before: string | null;
	readonly after: string | null;
};

/** @since @next */
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
 * @since @next
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

/** @since @next */
export type Applied = {
	readonly written: ReadonlyArray<string>;
	readonly removed: ReadonlyArray<string>;
};

/** Globs workspace-relative patterns and returns sorted workspace-relative paths. */
const globAll = (
	fs: FileSystem.FileSystem,
	location: Paths,
	patterns: ReadonlyArray<string>,
	exclude: ReadonlyArray<string>,
) =>
	Effect.map(
		Effect.forEach(patterns, (pattern) =>
			fs.glob(location.toFs(pattern), { exclude: exclude.map(location.toFs) }),
		),
		(results) =>
			Arr.sort(
				[
					...new Set(
						results.flat().flatMap((path) => {
							const rel = location.fromFs(path);
							return typeof rel === "string" ? [rel] : [];
						}),
					),
				],
				Order.String,
			),
	);

const occurrences = (text: string, token: string): ReadonlyArray<number> => {
	const found: Array<number> = [];
	if (token === "") return found;
	for (
		let index = text.indexOf(token);
		index !== -1;
		index = text.indexOf(token, index + token.length)
	)
		found.push(index);

	return found;
};

type Frame = {
	readonly object: boolean;
	readonly path: ReadonlyArray<string>;
	key: string | undefined;
	expectKey: boolean;
};

/** A string as JSON string content, without the surrounding quotes. */
const jsonContent = (value: string) => JSON.stringify(value).slice(1, -1);

/**
 * Finds the string value at a key path in JSON text, such as `["version"]` or
 * `["dependencies", "@acme/widgets"]`, counting from the top-level object. Nested
 * properties with the same name are never matched. Returns the span inside the quotes.
 */
const locate = (text: string, path: ReadonlyArray<string>) => {
	const stack: Array<Frame> = [];
	const here = (): ReadonlyArray<string> => {
		const top = stack.at(-1);
		if (top === undefined) return [];
		return top.key === undefined ? top.path : [...top.path, top.key];
	};
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === '"') {
			let end = index + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			const value: unknown = JSON.parse(text.slice(index, end + 1));
			const top = stack.at(-1);
			if (typeof value === "string" && top?.object === true && top.expectKey) {
				top.key = value;
				top.expectKey = false;
			} else if (typeof value === "string") {
				const keys = here();
				if (
					keys.length === path.length &&
					keys.every((key, position) => key === path[position])
				) {
					return { value, start: index + 1, end };
				}
			}
			index = end;
		} else if (char === "{" || char === "[") {
			stack.push({
				object: char === "{",
				path: char === "{" ? here() : [...here(), "[]"],
				key: undefined,
				expectKey: char === "{",
			});
		} else if (char === "}" || char === "]") {
			stack.pop();
		} else if (char === ",") {
			const top = stack.at(-1);
			if (top?.object === true) {
				top.key = undefined;
				top.expectKey = true;
			}
		}
	}

	return undefined;
};

// A file name with no directory part, drive, or stream suffix.
const plainFileName = /^(?!\.{1,2}$)[^/\\:\0]+$/;

/** Finds a dependency's range string inside one top-level dependency field. */
const findRange = (text: string, field: string, dependency: string) => {
	const found = locate(text, [field, dependency]);
	return found === undefined
		? undefined
		: { range: found.value, start: found.start, end: found.end };
};

/**
 * Reads pending modules, manifests, and replacement targets, and prepares every file
 * edit of a plan. It writes nothing. Problems are collected and reported together.
 *
 * @since @next
 */
export const prepare = (
	plan: Plan,
	options: PrepareOptions,
): Effect.Effect<Prepared, PrepareError | PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const location = paths(options);
		const reads = new Map<string, string | null>();
		// Keys are workspace-relative paths; the file system receives them through the location.
		const read = (key: string) =>
			Effect.gen(function* () {
				if (reads.has(key)) return reads.get(key) ?? null;
				const fsPath = location.toFs(key);
				const text = (yield* fs.exists(fsPath)) ? yield* fs.readFileString(fsPath) : null;
				reads.set(key, text);

				return text;
			});
		const issues: Array<Issue> = [];
		const resolved = (path: string | Issue): string | undefined => {
			if (typeof path === "string") return path;
			issues.push(path);
			return undefined;
		};
		const fromBase = (path: string) => resolved(location.fromBase(path));
		const fromRoot = (path: string) => resolved(location.fromRoot(path));
		const allFromBase = (patterns: ReadonlyArray<string>) =>
			patterns.flatMap((pattern) => {
				const path = fromBase(pattern);
				return path === undefined ? [] : [path];
			});
		const globs: Array<Prepared["globs"][number]> = [];
		const exportName = plan.exportName;

		// Resolved sources must be unchanged; apply checks them again.
		for (const [path, before] of options.snapshot?.reads ?? []) {
			if ((yield* read(path)) !== before) {
				issues.push(
					issue(
						"StaleSource",
						`${path} changed after input was resolved; resolve and plan again.`,
						[path],
					),
				);
			}
		}
		for (const glob of options.snapshot?.globs ?? []) {
			const matched = yield* globAll(fs, location, glob.pattern, []);
			const added = matched.filter((path) => !glob.matched.includes(path));
			const removed = glob.matched.filter((path) => !matched.includes(path));
			if (added.length > 0 || removed.length > 0) {
				issues.push(
					issue(
						"StaleSource",
						"The manifests matched while resolving input have changed; resolve and plan again.",
						[...added, ...removed],
					),
				);
			}
			globs.push({ pattern: glob.pattern, exclude: [], except: [], matched: glob.matched });
		}

		// Pending modules.
		const pendingPatterns = allFromBase(options.pending);
		const pendingPaths = yield* globAll(fs, location, pendingPatterns, []);
		globs.push({ pattern: pendingPatterns, exclude: [], except: [], matched: pendingPaths });
		const declarations = new Map<string, Declaration>();
		for (const path of pendingPaths) {
			const scanned = scan({ path, text: (yield* read(path)) ?? "" });
			if ("reason" in scanned) {
				issues.push(scanned);
				continue;
			}
			const existing = declarations.get(scanned.changeId);
			if (existing !== undefined) {
				issues.push(
					issue(
						"UnsupportedRelocation",
						`Change "${scanned.changeId}" is declared in ${existing.path} and ${path}.`,
						[existing.path, path],
					),
				);
				continue;
			}
			declarations.set(scanned.changeId, scanned);
		}
		const planned = new Set(
			plan.versions.flatMap((entry) => entry.version.changes.map((change) => change.id)),
		);
		for (const declaration of declarations.values()) {
			if (!planned.has(declaration.changeId)) {
				issues.push(
					issue(
						"UnplannedPending",
						`${declaration.path} declares "${declaration.changeId}", which the plan does not release. A release consumes every pending change in its scope.`,
						[declaration.path, declaration.changeId],
					),
				);
			}
		}

		const next = new Map<string, string | null>();
		const current = (path: string) =>
			Effect.map(read(path), (text) => (next.has(path) ? (next.get(path) ?? null) : text));
		const order: Array<string> = [];
		const stage = (path: string, after: string | null) => {
			if (!order.includes(path)) order.push(path);
			next.set(path, after);
		};

		// Version modules, written before anything is consumed.
		const registration = (entry: PlannedVersion) => {
			const files = plan.files.get(entry.package);
			return files === undefined ? undefined : { files };
		};
		for (const entry of plan.versions) {
			const configured = registration(entry)?.files;
			const versionsDir =
				configured === undefined ? undefined : fromBase(configured.versions);
			if (versionsDir === undefined) continue;
			// The file name is the version id, verbatim, so an id must be a plain file name.
			const previousId = entry.version.previous?.id ?? "";
			const unusable = [entry.version.id, previousId].filter((id) => !plainFileName.test(id));
			if (unusable.length > 0) {
				issues.push(
					issue(
						"VersionFileName",
						`${entry.package}: ${unusable.map((id) => `"${id}"`).join(", ")} cannot name a file in ${versionsDir}; version ids used as file names cannot contain path separators or ":".`,
						[entry.package, ...unusable],
					),
				);
				continue;
			}
			const target = join(versionsDir, `${entry.version.id}.ts`);
			if ((yield* read(target)) !== null) {
				issues.push(issue("VersionFileExists", `${target} already exists.`, [target]));
				continue;
			}
			const generated = join(versionsDir, `${previousId}.ts`);
			const explicit = options.previous?.find(
				(source) => source.package === entry.package && source.version === previousId,
			);
			const explicitModule = explicit === undefined ? undefined : fromBase(explicit.module);
			const previous =
				(yield* read(generated)) !== null
					? { specifier: relative(versionsDir, generated), exportName }
					: explicit !== undefined && explicitModule !== undefined
						? {
								specifier: relative(versionsDir, explicitModule),
								exportName: explicit.exportName,
							}
						: undefined;
			if (previous === undefined) {
				issues.push(
					issue(
						"MissingPreviousSource",
						`No module provides ${entry.package}@${previousId}. Generate it into ${versionsDir}, or pass it in previous.`,
						[entry.package, previousId],
					),
				);
			}
			const copied: Array<Declaration> = [];
			for (const change of entry.version.changes) {
				const declaration = declarations.get(change.id);
				if (declaration === undefined) {
					issues.push(
						issue(
							"MissingSource",
							`No pending module declares "${change.id}" for ${entry.package}.`,
							[entry.package, change.id],
						),
					);
				} else copied.push(declaration);
			}
			if (previous === undefined || copied.length !== entry.version.changes.length) continue;
			const rendered = render({
				path: target,
				version: entry.version,
				previous,
				declarations: copied,
				exportName,
				dependencies: entry.dependencies,
				consumed: pendingPaths,
			});
			if ("issues" in rendered) issues.push(...rendered.issues);
			else stage(target, rendered.text);
		}

		// Manifests.
		for (const entry of plan.versions) {
			const configured = registration(entry)?.files.manifest;
			const path = configured === undefined ? undefined : fromBase(configured);
			if (path === undefined) continue;
			const text = yield* current(path);
			const field = text === null ? undefined : locate(text, ["version"]);
			const previousId = entry.version.previous?.id;
			if (text === null || field === undefined || field.value !== previousId) {
				issues.push(
					issue(
						"ManifestMismatch",
						`${path} must have version ${previousId ?? "(none)"}; found ${field?.value ?? "no top-level version field"}.`,
						[path],
					),
				);
				continue;
			}
			stage(
				path,
				`${text.slice(0, field.start)}${jsonContent(entry.version.id)}${text.slice(field.end)}`,
			);
		}

		// Dependency ranges. Every edge the plan used must still match its manifest.
		const checked = new Set<string>();
		for (const proposal of plan.dependents) {
			const path = fromRoot(proposal.manifest);
			if (path === undefined) continue;
			const text = yield* read(path);
			const found =
				text === null ? undefined : findRange(text, proposal.field, proposal.dependency);
			const edge = JSON.stringify([path, proposal.field, proposal.dependency]);
			if (found?.range !== proposal.range && !checked.has(edge)) {
				issues.push(
					issue(
						"StaleRequirement",
						`${path}: ${proposal.field}["${proposal.dependency}"] is ${found === undefined ? "missing" : `"${found.range}"`}, but the plan used "${proposal.range}". Resolve requirements and plan again.`,
						[path, proposal.dependent, proposal.dependency, proposal.field],
					),
				);
			}
			checked.add(edge);
			if (proposal.action === "missing-selection") {
				issues.push(
					issue(
						"MissingSelection",
						`${proposal.dependent} must release because ${proposal.dependency} changes outside its range; select it in the plan.`,
						[proposal.dependent, proposal.dependency],
					),
				);
			}
		}
		for (const update of plan.dependencyUpdates) {
			const path = fromRoot(update.manifest);
			if (path === undefined) continue;
			const text = yield* current(path);
			const found =
				text === null ? undefined : findRange(text, update.field, update.dependency);
			if (text === null || found === undefined || found.range !== update.from) continue;
			stage(
				path,
				`${text.slice(0, found.start)}${jsonContent(update.to)}${text.slice(found.end)}`,
			);
		}

		// Literal replacements.
		const reports: Array<ReplacementReport> = [];
		const claimed = new Map<string, Array<{ start: number; end: number; rule: Replacement }>>();
		for (const rule of plan.replacements) {
			const patterns = allFromBase(rule.files);
			const exclude = allFromBase(rule.exclude ?? []);
			const found = yield* globAll(fs, location, patterns, exclude);
			// Pending modules are consumed, never replacement targets.
			const except = found.filter((path) => pendingPaths.includes(path));
			const matched = found.filter((path) => !except.includes(path));
			globs.push({ pattern: patterns, exclude, except, matched });
			const version = plan.versions.find((entry) => entry.package === rule.versionOf.name)
				?.version.id;
			const files: Array<{ path: string; occurrences: number }> = [];
			for (const path of matched) {
				const text = (yield* read(path)) ?? "";
				const starts = occurrences(text, rule.match);
				files.push({ path, occurrences: starts.length });
				const ranges = claimed.get(path) ?? [];
				for (const start of starts) {
					const end = start + rule.match.length;
					const overlap = ranges.find(
						(range) => range.rule !== rule && start < range.end && range.start < end,
					);
					if (overlap !== undefined) {
						issues.push(
							issue(
								"ReplacementConflict",
								`${path}: "${rule.match}" and "${overlap.rule.match}" replace the same text.`,
								[path, rule.match, overlap.rule.match],
							),
						);
					}
					ranges.push({ start, end, rule });
				}
				claimed.set(path, ranges);
			}
			reports.push({
				match: rule.match,
				versionOf: rule.versionOf.name,
				version,
				files,
				zeroMatches: files.every((file) => file.occurrences === 0),
			});
		}
		for (const [path, ranges] of claimed) {
			const original = (yield* read(path)) ?? "";
			let text = original;
			const applicable = ranges
				.map((range) => ({
					...range,
					version: plan.versions.find(
						(entry) => entry.package === range.rule.versionOf.name,
					)?.version.id,
				}))
				.filter((range) => range.version !== undefined);
			const descending = Arr.sort(
				applicable,
				Order.flip(
					Order.mapInput(
						Order.Number,
						(range: (typeof applicable)[number]) => range.start,
					),
				),
			);
			if (applicable.length === 0) continue;
			// Replacement offsets refer to the file as read; manifests are not replacement targets.
			if (next.has(path)) {
				issues.push(
					issue(
						"ReplacementConflict",
						`${path} is both a manifest and a replacement target.`,
						[path],
					),
				);
				continue;
			}
			for (const range of descending)
				text = `${text.slice(0, range.start)}${range.version}${text.slice(range.end)}`;
			stage(path, text);
		}

		// Pending modules are consumed last.
		for (const path of pendingPaths) stage(path, null);

		if (issues.length > 0) return yield* new PrepareError({ issues });

		const edits: Array<Edit> = [];
		for (const path of order)
			edits.push({ path, before: reads.get(path) ?? null, after: next.get(path) ?? null });

		return {
			_tag: "PreparedRelease",
			plan,
			edits,
			replacements: reports,
			location: { root: options.root, base: options.base },
			reads,
			globs,
		} satisfies Prepared;
	});

/**
 * Applies prepared edits to local files. It first checks that every file preparation
 * read is unchanged, and refuses with `StalePlan` otherwise. On failure, it restores the
 * files it changed where it can.
 *
 * @since @next
 */
export const apply = (
	prepared: Prepared,
): Effect.Effect<
	Applied,
	StalePlan | ApplyFailed | PlatformError.PlatformError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const location = paths(prepared.location);
		const contents = (path: string) =>
			Effect.gen(function* () {
				const fsPath = location.toFs(path);
				return (yield* fs.exists(fsPath)) ? yield* fs.readFileString(fsPath) : null;
			});
		const stale: Array<string> = [];
		for (const [path, before] of prepared.reads) {
			if ((yield* contents(path)) !== before) stale.push(path);
		}
		for (const glob of prepared.globs) {
			const matched = yield* globAll(fs, location, glob.pattern, glob.exclude);
			for (const path of matched) {
				if (
					!glob.matched.includes(path) &&
					!glob.except.includes(path) &&
					!stale.includes(path)
				)
					stale.push(path);
			}
		}
		if (stale.length > 0) return yield* new StalePlan({ paths: Arr.sort(stale, Order.String) });

		const done: Array<Edit> = [];
		const write = (edit: Edit) =>
			Effect.gen(function* () {
				const fsPath = location.toFs(edit.path);
				if (edit.after === null) {
					yield* fs.remove(fsPath);
					return;
				}
				// A new file may be the first in its directory, such as a fresh versions directory.
				if (edit.before === null) {
					yield* fs.makeDirectory(location.toFs(dirname(edit.path)), { recursive: true });
				}
				yield* fs.writeFileString(fsPath, edit.after);
			});

		/**
		 * Restores files this operation changed, newest first, while they still hold this
		 * operation's contents. Any other contents may be another writer's, so the file is left
		 * as it is and reported. That includes the failed edit's file when it holds neither its
		 * old nor its new contents: a partial write and an external edit look the same.
		 */
		const recover = (failed: Edit | undefined) =>
			Effect.gen(function* () {
				const restored: Array<string> = [];
				const unrestored: Array<{ path: string; cause: unknown }> = [];
				const attempts = [...(failed === undefined ? [] : [failed]), ...Arr.reverse(done)];
				for (const edit of attempts) {
					const now = yield* Effect.result(contents(edit.path));
					if (now._tag === "Failure") {
						unrestored.push({ path: edit.path, cause: now.failure });
						continue;
					}
					if (now.success === edit.before) {
						if (edit !== failed) restored.push(edit.path);
						continue;
					}
					if (now.success !== edit.after) {
						unrestored.push({
							path: edit.path,
							cause: new ChangedDuringApply({ path: edit.path }),
						});
						continue;
					}
					const restore = yield* Effect.result(
						edit.before === null
							? fs.remove(location.toFs(edit.path))
							: fs.writeFileString(location.toFs(edit.path), edit.before),
					);
					if (restore._tag === "Success") restored.push(edit.path);
					else unrestored.push({ path: edit.path, cause: restore.failure });
				}

				return { restored, unrestored };
			});

		for (const edit of prepared.edits) {
			// Check the file again right before writing it, so an external change made while
			// earlier edits were written is never overwritten.
			const now = yield* Effect.result(contents(edit.path));
			if (now._tag === "Failure" || now.success !== edit.before) {
				const recovered = yield* recover(undefined);
				return yield* new ApplyFailed({
					path: edit.path,
					cause:
						now._tag === "Failure"
							? now.failure
							: new ChangedDuringApply({ path: edit.path }),
					...recovered,
				});
			}
			const result = yield* Effect.result(write(edit));
			if (result._tag === "Success") {
				done.push(edit);
				continue;
			}
			const recovered = yield* recover(edit);

			return yield* new ApplyFailed({ path: edit.path, cause: result.failure, ...recovered });
		}

		return {
			written: done.filter((edit) => edit.after !== null).map((edit) => edit.path),
			removed: done.filter((edit) => edit.after === null).map((edit) => edit.path),
		};
	});
