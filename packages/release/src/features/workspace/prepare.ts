import { Array as Arr, Effect, FileSystem, Order } from "effect";
import type { PlatformError } from "effect";

import { issue, PrepareError } from "../../foundation/error.ts";
import type { Issue } from "../../foundation/error.ts";
import { findRange, jsonContent, locate } from "../../foundation/npm/index.ts";
import type { Release } from "../planning/index.ts";
import type { Edit, Prepared, PrepareOptions, ReplacementReport } from "./files.ts";
import { globAll } from "./glob.ts";
import { join, paths, relative } from "./paths.ts";
import { render, scan } from "./source.ts";
import type { Declaration } from "./source.ts";
import { parseIndex, renderIndex } from "./version-index.ts";

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

// A file name with no directory part, drive, or stream suffix.
const plainFileName = /^(?!\.{1,2}$)[^/\\:\0]+$/;

/**
 * Reads pending modules, manifests, and replacement targets, and prepares every file
 * edit of a plan. It writes nothing. Problems are collected and reported together.
 *
 * @since 0.0.1
 */
export const prepare = (
	plan: Release.Plan,
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
			patterns.flatMap((pattern) => fromBase(pattern) ?? []);
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
		const registration = (entry: Release.PlannedVersion) => {
			const files = plan.files.get(entry.package);
			return files === undefined ? undefined : { files };
		};
		// Each version index belongs to one package.
		const indexed = new Map<string, Array<string>>();
		for (const [name, files] of plan.files) {
			if (files.index === false) continue;
			// Paths outside the workspace are reported where they are used.
			const dir = location.fromBase(files.versions);
			if (typeof dir === "string") indexed.set(dir, [...(indexed.get(dir) ?? []), name]);
		}
		for (const [dir, names] of indexed) {
			if (names.length > 1) {
				issues.push(
					issue(
						"SharedVersionsDirectory",
						`${names.join(", ")} share ${dir}, so they cannot each keep a version index there. Give each package its own versions directory, or set index: false.`,
						[dir, ...names],
					),
				);
			}
		}
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
			const indexPath =
				configured?.index === false ? undefined : join(versionsDir, "index.ts");
			if (indexPath !== undefined && entry.version.id === "index") {
				issues.push(
					issue(
						"VersionFileName",
						`${entry.package}: "index" cannot name a version file in ${versionsDir}, which holds the version index.`,
						[entry.package, entry.version.id],
					),
				);
				continue;
			}
			const target = join(versionsDir, `${entry.version.id}.ts`);
			if ((yield* read(target)) !== null) {
				issues.push(issue("VersionFileExists", `${target} already exists.`, [target]));
				continue;
			}
			const indexText = indexPath === undefined ? null : yield* read(indexPath);
			const listed = indexText === null ? [] : parseIndex(indexText);
			if (
				indexPath !== undefined &&
				(listed === undefined ||
					listed.some((listedEntry) => listedEntry.id === entry.version.id))
			) {
				issues.push(
					issue(
						"InvalidVersionIndex",
						`${indexPath} is not a generated version index; restore it from version control.`,
						[indexPath],
					),
				);
				continue;
			}
			const generated = join(versionsDir, `${previousId}.ts`);
			const explicit = options.previous?.find(
				(source) => source.package === entry.package && source.version === previousId,
			);
			const explicitModule = explicit === undefined ? undefined : fromBase(explicit.module);
			// An indexed predecessor keeps the export name it was generated with.
			const previousExport =
				listed?.find((listedEntry) => listedEntry.id === previousId)?.exportName ??
				exportName;
			const previous =
				(yield* read(generated)) !== null
					? { specifier: relative(versionsDir, generated), exportName: previousExport }
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
			if ("issues" in rendered) {
				issues.push(...rendered.issues);
				continue;
			}
			stage(target, rendered.text);
			if (indexPath === undefined || listed === undefined) continue;
			stage(indexPath, renderIndex([...listed, { id: entry.version.id, exportName }]));
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
		const claimed = new Map<
			string,
			Array<{ start: number; end: number; rule: Release.Replacement }>
		>();
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
			const applicable = ranges.flatMap((range) => {
				const version = plan.versions.find(
					(entry) => entry.package === range.rule.versionOf.name,
				)?.version.id;

				return version === undefined ? [] : { ...range, version };
			});
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
