import { Array as Arr, Effect, type FileSystem, Order } from "effect";

import type { Paths } from "./paths.ts";

/** Globs workspace-relative patterns and returns sorted workspace-relative paths. */
export const globAll = (
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
