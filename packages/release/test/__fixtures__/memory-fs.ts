import { Effect, FileSystem, PlatformError } from "effect";

const notFound = (method: string, path: string) =>
	PlatformError.systemError({
		_tag: "NotFound",
		module: "FileSystem",
		method,
		description: "No such file",
		pathOrDescriptor: path,
	});

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const toRegExp = (pattern: string) => {
	const source = pattern
		.split("**/")
		.map((part) =>
			part
				.split("**")
				.map((piece) =>
					piece
						.split("*")
						.map((literal) => escape(literal).replace(/\?/g, "[^/]"))
						.join("[^/]*"),
				)
				.join(".*"),
		)
		.join("(?:.*/)?");

	return new RegExp(`^${source}$`);
};

/**
 * A file system held in a map, with an optional write failure for one path.
 */
export const memoryFs = (
	initial: Record<string, string>,
	options: { readonly failWrite?: string } = {},
) => {
	const files = new Map(Object.entries(initial));
	const fs = FileSystem.makeNoop({
		exists: (path) => Effect.succeed(files.has(path)),
		readFileString: (path) => {
			const text = files.get(path);

			return text === undefined
				? Effect.fail(notFound("readFileString", path))
				: Effect.succeed(text);
		},
		writeFileString: (path, data) => {
			if (path === options.failWrite) return Effect.fail(notFound("writeFileString", path));
			files.set(path, data);

			return Effect.void;
		},
		remove: (path) => {
			files.delete(path);

			return Effect.void;
		},
		glob: (pattern, globOptions) => {
			const include = toRegExp(pattern);
			const exclude = (globOptions?.exclude ?? []).map(toRegExp);

			return Effect.succeed(
				[...files.keys()].filter(
					(path) => include.test(path) && !exclude.some((regex) => regex.test(path)),
				),
			);
		},
	});

	return {
		files,
		provide: Effect.provideService(FileSystem.FileSystem, fs),
	};
};
