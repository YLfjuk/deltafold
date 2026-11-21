import { Array as Arr, Effect, type FileSystem, Order } from "effect";

import type { Paths } from "./paths.ts";

/**
 * Globs workspace-relative patterns and returns sorted workspace-relative paths. The
 * workspace root is the walk's `root`, so it is never read as glob syntax.
 */
export const globAll = (
	fs: FileSystem.FileSystem,
	location: Paths,
	patterns: ReadonlyArray<string>,
	exclude: ReadonlyArray<string>,
) =>
	Effect.map(
		Effect.forEach(patterns, (pattern) =>
			fs.glob(pattern, { root: location.toFs(""), exclude }),
		),
		(results) => Arr.sort([...new Set(results.flat())], Order.String),
	);
