import {
	Array as Arr,
	Context,
	Data,
	Effect,
	FileSystem,
	Layer,
	Order,
	Path,
	RcMap,
	Scope,
	Semaphore,
} from "effect";
import type { Snapshot } from "typescript-7.1/async";

import * as PackageConfig from "./configs/package.ts";
import { CompilerFailed, ReadFailed, WriteFailed } from "./errors.ts";

/** The path is absolute and `/`-separated, and the text has no byte order mark. */
export type OpenFile = {
	readonly path: string;
	readonly text: string;
};

/** The compiler can know a file under another name, such as a `.json` name for a `.jsonc` file. */
export type Opened = {
	readonly snapshot: Snapshot;
	readonly compilerPath: (path: string) => string;
};

export type Compiler = {
	readonly open: (
		files: ReadonlyArray<OpenFile>,
	) => Effect.Effect<Opened, CompilerUnavailable, Scope.Scope>;
};

export class CompilerUnavailable extends Data.TaggedError(
	`${PackageConfig.name}/CompilerUnavailable`,
)<{
	readonly cause: unknown;
}> {}

/** `expected` is the content the file must still have. */
export type Write = {
	readonly path: string;
	readonly expected: string;
	readonly text: string;
};

const InternalId = `~${PackageConfig.name}/Workspace` as const;

/** Workspace operations that only the handlers of this package use. */
export type Internals = {
	readonly caseSensitive: boolean;
	readonly absolute: (path: string) => string;
	/** Case-folded on case-insensitive file systems. */
	readonly canonical: (absolutePath: string) => string;
	readonly match: (
		actionId: string,
		include: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<string>, ReadFailed>;
	readonly read: (actionId: string, path: string) => Effect.Effect<string, ReadFailed>;
	readonly write: (
		actionId: string,
		writes: ReadonlyArray<Write>,
	) => Effect.Effect<void, WriteFailed>;
	readonly open: (
		actionId: string,
		files: ReadonlyArray<OpenFile>,
	) => Effect.Effect<Opened, CompilerFailed, Scope.Scope>;
};

/**
 * `TypeScriptNode.layer` provides it.
 *
 * @since @next
 */
export type Workspace = {
	/** Absolute and `/`-separated. Payload globs are relative to it. */
	readonly root: string;
	/**
	 * Holds the locks until the current scope closes. This package's handlers lock every
	 * file they may write. `./a.ts` and `a.ts` share a lock. Locks are not reentrant, so
	 * locking a path the fiber already holds waits until it is interrupted.
	 */
	readonly lock: (paths: ReadonlyArray<string>) => Effect.Effect<void, never, Scope.Scope>;
	readonly [InternalId]: Internals;
};

/** @since @next */
export const Workspace = Context.Service<Workspace>(`${PackageConfig.name}/Workspace`);

export const internals = (workspace: Workspace): Internals => workspace[InternalId];

/** Matching never selects files with this suffix. */
export const temporarySuffix = ".deltafold-tmp";

const toPosix = (path: string) => path.replaceAll("\\", "/");

/** An unclosed `{` stays literal. */
const expandBraces = (pattern: string): ReadonlyArray<string> => {
	const open = pattern.indexOf("{");
	if (open === -1) return [pattern];
	const head = pattern.slice(0, open);
	const alternatives: Array<string> = [];
	let depth = 0;
	let from = open + 1;
	for (let index = open; index < pattern.length; index++) {
		const char = pattern.charAt(index);
		if (char === "{") depth++;
		else if (char === "," && depth === 1) {
			alternatives.push(pattern.slice(from, index));
			from = index + 1;
		} else if (char === "}" && --depth === 0) {
			alternatives.push(pattern.slice(from, index));
			const tail = pattern.slice(index + 1);

			return alternatives.flatMap((alternative) => expandBraces(head + alternative + tail));
		}
	}

	return expandBraces(pattern.slice(open + 1)).map((rest) => `${head}{${rest}`);
};

const escapesPath = (path: string) =>
	/^(\/|[A-Za-z]:)/.test(path) || path.split("/").includes("..");

/** `{.,}./a` stands for `../a`, so it escapes. */
const escapesRoot = (pattern: string) => expandBraces(toPosix(pattern)).some(escapesPath);

const swapCase = (text: string) =>
	Array.from(text, (char) => {
		const lower = char.toLowerCase();

		return char === lower ? char.toUpperCase() : lower;
	}).join("");

/** Keeps a leading byte order mark. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

const errorMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

export const make = (options: {
	readonly root: string;
	readonly compiler: Compiler;
}): Effect.Effect<Workspace, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const resolved = path.resolve(options.root);
		const realRoot = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
		const root = toPosix(realRoot).replace(/\/$/, "");

		// The root with its last segment in another case resolves to the root only when the
		// root's own directory ignores case.
		const leaf = path.basename(realRoot);
		const probe = path.join(path.dirname(realRoot), swapCase(leaf));
		const caseSensitive =
			probe === realRoot ||
			!(yield* fs.realPath(probe).pipe(
				Effect.map((real) => real.toLowerCase() === realRoot.toLowerCase()),
				Effect.orElseSucceed(() => false),
			));

		// Joining resolves `.` and `..` segments, so aliases of one file share a lock key.
		const absolute = (relative: string) => toPosix(path.join(root, relative));
		const canonical = (absolutePath: string) => {
			const posix = toPosix(absolutePath);

			return caseSensitive ? posix : posix.toLowerCase();
		};

		const semaphores = yield* RcMap.make({ lookup: (_key: string) => Semaphore.make(1) });

		const lock = (paths: ReadonlyArray<string>) =>
			Effect.gen(function* () {
				const keys = Arr.sort(
					new Set(paths.map((relative) => canonical(absolute(relative)))),
					Order.String,
				);
				for (const key of keys) {
					const semaphore = yield* RcMap.get(semaphores, key);
					// Waiting for the permit stays interruptible; once taken, its release is
					// registered before anything can interrupt.
					yield* Effect.uninterruptibleMask((restore) =>
						Effect.andThen(
							restore(semaphore.take(1)),
							Effect.addFinalizer(() => semaphore.release(1)),
						),
					);
				}
			});

		const readFailed =
			(actionId: string, target: string, reason: ReadFailed["reason"]) => (cause?: unknown) =>
				new ReadFailed({ actionId, root, path: target, reason, cause });

		const match = (actionId: string, include: ReadonlyArray<string>) =>
			Effect.gen(function* () {
				for (const pattern of include) {
					if (escapesRoot(pattern))
						return yield* readFailed(actionId, pattern, "pattern")();
				}
				const found = new Set<string>();
				for (const pattern of include) {
					const matches = yield* fs
						.glob(toPosix(pattern), {
							root: realRoot,
							exclude: ["**/node_modules", "**/node_modules/**"],
						})
						.pipe(Effect.mapError(readFailed(actionId, pattern, "unreadable")));
					for (const matched of matches) {
						if (!matched.endsWith(temporarySuffix)) found.add(toPosix(matched));
					}
				}

				const files: Array<string> = [];
				for (const relative of Arr.sort(found, Order.String)) {
					const target = absolute(relative);
					// Check every match too, so no pattern can reach a file outside the root.
					if (
						escapesPath(relative) ||
						!canonical(target).startsWith(`${canonical(root)}/`)
					) {
						return yield* readFailed(actionId, relative, "pattern")();
					}
					const info = yield* fs
						.stat(target)
						.pipe(Effect.mapError(readFailed(actionId, relative, "unreadable")));
					const link = yield* fs.readLink(target).pipe(
						Effect.as(true),
						Effect.orElseSucceed(() => false),
					);
					if (link) return yield* readFailed(actionId, relative, "link")();
					if (info.type === "Directory") continue;
					const real = yield* fs
						.realPath(target)
						.pipe(Effect.mapError(readFailed(actionId, relative, "unreadable")));
					if (canonical(real) !== canonical(target)) {
						return yield* readFailed(actionId, relative, "link")();
					}
					files.push(relative);
				}

				return files;
			});

		const readText = (target: string) =>
			Effect.map(fs.readFile(target), (bytes) => decoder.decode(bytes));

		const read = (actionId: string, relative: string) =>
			readText(absolute(relative)).pipe(
				Effect.mapError(readFailed(actionId, relative, "unreadable")),
			);

		const write = (actionId: string, writes: ReadonlyArray<Write>) => {
			const staged = writes.map((entry, index) => {
				const target = absolute(entry.path);
				const slash = target.lastIndexOf("/");
				const random = Math.random().toString(36).slice(2, 10);
				const temporary = `${target.slice(0, slash)}/.${target.slice(slash + 1)}.${random}${temporarySuffix}`;

				return { ...entry, index, target, temporary };
			});

			// A failure before the first rename leaves every original unchanged, so every
			// other file is still pending. While renaming, only later files are.
			const failed = (
				entry: (typeof staged)[number],
				phase: "staging" | "renaming",
				reason: string,
				written: ReadonlyArray<string>,
				cause?: unknown,
			) =>
				new WriteFailed({
					actionId,
					root,
					writtenPaths: written,
					failed: {
						path: entry.path,
						status: phase === "staging" ? "not-written" : "unknown",
						reason,
						cause,
					},
					pendingPaths: staged.flatMap((other) =>
						(
							phase === "staging"
								? other.index !== entry.index
								: other.index > entry.index
						)
							? [other.path]
							: [],
					),
				});

			const cleanup = Effect.forEach(staged, ({ temporary }) =>
				fs.remove(temporary).pipe(Effect.ignore),
			);

			return Effect.gen(function* () {
				for (const entry of staged) {
					yield* fs.writeFileString(entry.temporary, entry.text).pipe(
						Effect.andThen(
							fs.stat(entry.target).pipe(
								Effect.flatMap((info) =>
									fs.chmod(entry.temporary, info.mode & 0o7777),
								),
								Effect.ignore,
							),
						),
						Effect.mapError((cause) =>
							failed(
								entry,
								"staging",
								`Could not write a temporary file: ${errorMessage(cause)}`,
								[],
								cause,
							),
						),
					);
				}
				// Check every original before renaming any, so a conflict replaces nothing.
				for (const entry of staged) {
					const current = yield* readText(entry.target).pipe(
						Effect.mapError((cause) =>
							failed(
								entry,
								"staging",
								`Could not read the file: ${errorMessage(cause)}`,
								[],
								cause,
							),
						),
					);
					if (current !== entry.expected) {
						return yield* failed(
							entry,
							"staging",
							"The file changed after it was read",
							[],
						);
					}
				}
				const written: Array<string> = [];
				for (const entry of staged) {
					yield* fs
						.rename(entry.temporary, entry.target)
						.pipe(
							Effect.mapError((cause) =>
								failed(
									entry,
									"renaming",
									`Could not replace the file: ${errorMessage(cause)}`,
									written,
									cause,
								),
							),
						);
					written.push(entry.path);
				}

				return written;
			}).pipe(Effect.asVoid, Effect.ensuring(cleanup), Effect.uninterruptible);
		};

		const open = (actionId: string, files: ReadonlyArray<OpenFile>) =>
			options.compiler
				.open(files.map((file) => ({ path: absolute(file.path), text: file.text })))
				.pipe(
					Effect.mapError(
						(error) =>
							new CompilerFailed({
								actionId,
								root,
								stage: "snapshot",
								cause: error.cause,
							}),
					),
				);

		return {
			root,
			lock,
			[InternalId]: { caseSensitive, absolute, canonical, match, read, write, open },
		} satisfies Workspace;
	});

export const layer = (options: { readonly root: string; readonly compiler: Compiler }) =>
	Layer.effect(Workspace, make(options));
