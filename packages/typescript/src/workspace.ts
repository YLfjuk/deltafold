import {
	Array as Arr,
	Context,
	Data,
	Effect,
	FileSystem,
	Layer,
	Path,
	RcMap,
	Scope,
	Semaphore,
} from "effect";
import type { Snapshot } from "typescript-7.1/async";

import { CompilerFailed, ReadFailed, WriteFailed, type WriteStatus } from "./errors.ts";
import { byCodePoint, isContainedPattern, swapCase, toPosix } from "./paths.ts";

/**
 * Opens compiler snapshots for absolute, `/`-separated file paths. The Node entry point
 * provides one that runs the TypeScript compiler.
 */
export type Compiler = {
	readonly open: (
		files: ReadonlyArray<string>,
	) => Effect.Effect<Snapshot, CompilerUnavailable, Scope.Scope>;
};

/** A compiler that could not open a snapshot, with the original failure. */
export class CompilerUnavailable extends Data.TaggedError("CompilerUnavailable")<{
	readonly cause: unknown;
}> {}

/** A file the write step replaces: its expected current content and its new content. */
export type Write = {
	readonly path: string;
	readonly expected: string;
	readonly text: string;
};

const InternalId = "~@deltafold/typescript/Workspace";

/** Workspace operations that only the handlers of this package use. */
export type Internals = {
	readonly caseSensitive: boolean;
	/** The absolute, `/`-separated path of a root-relative path. */
	readonly absolute: (path: string) => string;
	/** A comparable key for an absolute path: case-folded on case-insensitive file systems. */
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
		paths: ReadonlyArray<string>,
	) => Effect.Effect<Snapshot, CompilerFailed, Scope.Scope>;
};

/**
 * The root of a run, its file locks, and its compiler. `TypeScriptNode.layer` provides
 * it.
 *
 * @since @next
 */
export type Workspace = {
	/** The absolute, `/`-separated root that payload globs are relative to. */
	readonly root: string;
	/**
	 * Holds the locks of root-relative paths until the current scope closes. Handlers of
	 * this package lock every file they may write; a custom handler that writes the same
	 * files can take the same locks. Locks are acquired in sorted order and are not
	 * reentrant: a fiber that locks a path it already holds waits forever.
	 */
	readonly lock: (paths: ReadonlyArray<string>) => Effect.Effect<void, never, Scope.Scope>;
	readonly [InternalId]: Internals;
};

/**
 * The `Workspace` service.
 *
 * @since @next
 */
export const Workspace = Context.Service<Workspace>("@deltafold/typescript/Workspace");

/** The workspace operations that only the handlers of this package use. */
export const internals = (workspace: Workspace): Internals => workspace[InternalId];

const temporarySuffix = ".deltafold-tmp";

/** Decodes UTF-8 file bytes and keeps a leading byte order mark. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

const errorMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

/** Builds a workspace on Effect's file system, for a root and a compiler. */
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

		const probe = swapCase(realRoot);
		const caseSensitive =
			probe === realRoot ||
			!(yield* fs.realPath(probe).pipe(
				Effect.map((real) => real.toLowerCase() === realRoot.toLowerCase()),
				Effect.orElseSucceed(() => false),
			));

		const absolute = (relative: string) => `${root}/${relative}`;
		const canonical = (absolutePath: string) => {
			const posix = toPosix(absolutePath);

			return caseSensitive ? posix : posix.toLowerCase();
		};

		const semaphores = yield* RcMap.make({ lookup: (_key: string) => Semaphore.make(1) });

		const lock = (paths: ReadonlyArray<string>) =>
			Effect.gen(function* () {
				const keys = Arr.sort(
					new Set(paths.map((relative) => canonical(absolute(relative)))),
					byCodePoint,
				);
				for (const key of keys) {
					const semaphore = yield* RcMap.get(semaphores, key);
					yield* Effect.acquireRelease(semaphore.take(1), () => semaphore.release(1));
				}
			});

		const readFailed =
			(actionId: string, target: string, reason: ReadFailed["reason"]) => (cause?: unknown) =>
				new ReadFailed({ actionId, root, path: target, reason, cause });

		const match = (actionId: string, include: ReadonlyArray<string>) =>
			Effect.gen(function* () {
				for (const pattern of include) {
					if (!isContainedPattern(pattern))
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
					for (const matched of matches) found.add(toPosix(matched));
				}

				const files: Array<string> = [];
				for (const relative of Arr.sort(found, byCodePoint)) {
					const target = absolute(relative);
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
			const failed = (
				index: number,
				status: WriteStatus,
				reason: string,
				written: ReadonlyArray<string>,
				cause?: unknown,
			) =>
				new WriteFailed({
					actionId,
					root,
					writtenPaths: written,
					failed: { path: writes[index]!.path, status, reason, cause },
					pendingPaths: writes.slice(index + 1).map((entry) => entry.path),
				});

			const temporaries = writes.map(({ path: relative }) => {
				const target = absolute(relative);
				const slash = target.lastIndexOf("/");
				const random = Math.random().toString(36).slice(2, 10);

				return `${target.slice(0, slash)}/.${target.slice(slash + 1)}.${random}${temporarySuffix}`;
			});
			const cleanup = Effect.forEach(temporaries, (temporary) =>
				fs.remove(temporary).pipe(Effect.ignore),
			);

			return Effect.gen(function* () {
				// Pass 1: write every temporary file, keeping the original's mode.
				for (const [index, entry] of writes.entries()) {
					const target = absolute(entry.path);
					const temporary = temporaries[index]!;
					yield* fs.writeFileString(temporary, entry.text).pipe(
						Effect.andThen(
							fs.stat(target).pipe(
								Effect.flatMap((info) => fs.chmod(temporary, info.mode & 0o7777)),
								Effect.ignore,
							),
						),
						Effect.mapError((cause) =>
							failed(
								index,
								"not-written",
								`Could not write a temporary file: ${errorMessage(cause)}`,
								[],
								cause,
							),
						),
					);
				}
				// Pass 2: check that every original still has the content that was read.
				for (const [index, entry] of writes.entries()) {
					const current = yield* readText(absolute(entry.path)).pipe(
						Effect.mapError((cause) =>
							failed(
								index,
								"not-written",
								`Could not read the file: ${errorMessage(cause)}`,
								[],
								cause,
							),
						),
					);
					if (current !== entry.expected) {
						return yield* failed(
							index,
							"not-written",
							"The file changed after it was read",
							[],
						);
					}
				}
				// Pass 3: replace each original.
				const written: Array<string> = [];
				for (const [index, entry] of writes.entries()) {
					yield* fs
						.rename(temporaries[index]!, absolute(entry.path))
						.pipe(
							Effect.mapError((cause) =>
								failed(
									index,
									"unknown",
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

		const open = (actionId: string, paths: ReadonlyArray<string>) =>
			options.compiler.open(paths.map(absolute)).pipe(
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

/** A layer that builds the workspace on Effect's file system. */
export const layer = (options: { readonly root: string; readonly compiler: Compiler }) =>
	Layer.effect(Workspace, make(options));
