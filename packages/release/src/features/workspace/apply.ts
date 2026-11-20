import { Array as Arr, Effect, FileSystem, Order, type PlatformError } from "effect";

import { ApplyFailed, ChangedDuringApply, StalePlan } from "../../foundation/error.ts";
import type { Applied, Edit, Prepared } from "./files.ts";
import { globAll } from "./glob.ts";
import { dirname, paths } from "./paths.ts";

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
