import { Array as Arr, Effect, FileSystem, Order, type PlatformError } from "effect";

import { ApplyFailed, issue, PrepareError, StalePlan, type Issue } from "./error.ts";
import type { Plan, PlannedVersion, Replacement } from "./release.ts";
import { join, relative, render, scan, type Declaration } from "./source.ts";

/**
 * A version module that the plan's previous version can be imported from when it was
 * not generated into the versions directory.
 *
 * @since @next
 */
export type PreviousSource = {
	readonly package: string;
	readonly version: string;
	/** Module path relative to the working directory. */
	readonly module: string;
	readonly exportName: string;
};

/** @since @next */
export type PrepareOptions = {
	/** Glob patterns of pending change modules in the group's scope. */
	readonly pending: ReadonlyArray<string>;
	readonly previous?: ReadonlyArray<PreviousSource>;
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
	readonly reads: ReadonlyMap<string, string | null>;
	readonly globs: ReadonlyArray<{
		readonly pattern: ReadonlyArray<string>;
		readonly exclude: ReadonlyArray<string>;
		readonly matched: ReadonlyArray<string>;
	}>;
};

/** @since @next */
export type Applied = {
	readonly written: ReadonlyArray<string>;
	readonly removed: ReadonlyArray<string>;
};

const normalizePath = (path: string) => join(path);

const globAll = (
	fs: FileSystem.FileSystem,
	patterns: ReadonlyArray<string>,
	exclude: ReadonlyArray<string>,
) =>
	Effect.map(
		Effect.forEach(patterns, (pattern) => fs.glob(pattern, { exclude })),
		(results) => Arr.sort([...new Set(results.flat().map(normalizePath))], Order.String),
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
		const reads = new Map<string, string | null>();
		const read = (path: string) =>
			Effect.gen(function* () {
				const key = normalizePath(path);
				if (reads.has(key)) return reads.get(key) ?? null;
				const text = (yield* fs.exists(key)) ? yield* fs.readFileString(key) : null;
				reads.set(key, text);

				return text;
			});
		const issues: Array<Issue> = [];
		const globs: Array<Prepared["globs"][number]> = [];
		const exportName = plan.release.config.exportName ?? "version";

		// Pending modules.
		const pendingPaths = yield* globAll(fs, options.pending, []);
		globs.push({ pattern: options.pending, exclude: [], matched: pendingPaths });
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
		const registration = (entry: PlannedVersion) =>
			plan.release.config.packages.find(
				(candidate) => candidate.package.name === entry.package,
			);
		for (const entry of plan.versions) {
			const files = registration(entry)?.files;
			if (files === undefined) {
				issues.push(
					issue(
						"MissingSource",
						`${entry.package} has no files configured for version modules.`,
						[entry.package],
					),
				);
				continue;
			}
			const target = join(files.versions, `${entry.version.id}.ts`);
			if ((yield* read(target)) !== null) {
				issues.push(issue("VersionFileExists", `${target} already exists.`, [target]));
				continue;
			}
			const previousId = entry.version.previous?.id ?? "";
			const generated = join(files.versions, `${previousId}.ts`);
			const explicit = options.previous?.find(
				(source) => source.package === entry.package && source.version === previousId,
			);
			const previous =
				(yield* read(generated)) !== null
					? { specifier: relative(files.versions, generated), exportName }
					: explicit !== undefined
						? {
								specifier: relative(files.versions, explicit.module),
								exportName: explicit.exportName,
							}
						: undefined;
			if (previous === undefined) {
				issues.push(
					issue(
						"MissingPreviousSource",
						`No module provides ${entry.package}@${previousId}. Generate it into ${files.versions}, or pass it in previous.`,
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
				line: entry.line,
				consumed: pendingPaths,
			});
			if ("issues" in rendered) issues.push(...rendered.issues);
			else stage(target, rendered.text);
		}

		// Manifests.
		for (const entry of plan.versions) {
			const manifest = registration(entry)?.files?.manifest;
			if (manifest === undefined) continue;
			const path = normalizePath(manifest);
			const text = yield* current(path);
			const field = text === null ? null : /("version"\s*:\s*")([^"]*)(")/.exec(text);
			const previousId = entry.version.previous?.id;
			if (text === null || field === null || field[2] !== previousId) {
				issues.push(
					issue(
						"ManifestMismatch",
						`${path} must have version ${previousId ?? "(none)"}; found ${field?.[2] ?? "no version field"}.`,
						[path],
					),
				);
				continue;
			}
			stage(path, text.replace(field[0], `${field[1]}${entry.version.id}${field[3]}`));
		}

		// Literal replacements.
		const reports: Array<ReplacementReport> = [];
		const claimed = new Map<string, Array<{ start: number; end: number; rule: Replacement }>>();
		for (const rule of plan.replacements) {
			const exclude = rule.exclude ?? [];
			const matched = (yield* globAll(fs, rule.files, exclude)).filter(
				(path) => !pendingPaths.includes(path),
			);
			globs.push({ pattern: rule.files, exclude, matched });
			const version = plan.versions.find((entry) => entry.package === rule.versionOf.name)
				?.version.id;
			const files: Array<{ path: string; occurrences: number }> = [];
			for (const path of matched) {
				const text = (yield* read(path)) ?? "";
				const found = occurrences(text, rule.match);
				files.push({ path, occurrences: found.length });
				const ranges = claimed.get(path) ?? [];
				for (const start of found) {
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
		const stale: Array<string> = [];
		for (const [path, before] of prepared.reads) {
			const now = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : null;
			if (now !== before) stale.push(path);
		}
		for (const glob of prepared.globs) {
			const matched = yield* globAll(fs, glob.pattern, glob.exclude);
			for (const path of matched)
				if (!glob.matched.includes(path) && !stale.includes(path)) stale.push(path);
		}
		if (stale.length > 0) return yield* new StalePlan({ paths: Arr.sort(stale, Order.String) });

		const done: Array<Edit> = [];
		for (const edit of prepared.edits) {
			const result = yield* Effect.result(
				edit.after === null
					? fs.remove(edit.path)
					: fs.writeFileString(edit.path, edit.after),
			);
			if (result._tag === "Success") {
				done.push(edit);
				continue;
			}
			const restored: Array<string> = [];
			const unrestored: Array<{ path: string; cause: unknown }> = [];
			for (const applied of Arr.reverse(done)) {
				const restore = yield* Effect.result(
					applied.before === null
						? fs.remove(applied.path)
						: fs.writeFileString(applied.path, applied.before),
				);
				if (restore._tag === "Success") restored.push(applied.path);
				else unrestored.push({ path: applied.path, cause: restore.failure });
			}

			return yield* new ApplyFailed({
				path: edit.path,
				cause: result.failure,
				restored,
				unrestored,
			});
		}

		return {
			written: done.filter((edit) => edit.after !== null).map((edit) => edit.path),
			removed: done.filter((edit) => edit.after === null).map((edit) => edit.path),
		};
	});
