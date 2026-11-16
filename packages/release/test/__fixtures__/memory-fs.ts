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
 * A file system held in a map. Options inject faults: a write that fails without touching
 * the file, a write that leaves partial contents and then fails, and a hook that runs
 * before each write, for simulating another writer.
 */
export const memoryFs = (
	initial: Record<string, string>,
	options: {
		readonly failWrite?: string;
		/** A write that fails once without touching the file. */
		readonly failWriteOnce?: string;
		readonly partialWrite?: { readonly path: string; readonly contents: string };
		readonly beforeWrite?: (path: string, files: Map<string, string>) => void;
	} = {},
) => {
	const files = new Map(Object.entries(initial));
	const directories: Array<string> = [];
	// A partial write happens once, like a real interrupted write.
	let partialWritten = false;
	let failedOnce = false;
	const fs = FileSystem.makeNoop({
		exists: (path) => Effect.succeed(files.has(path)),
		readFileString: (path) => {
			const text = files.get(path);

			return text === undefined
				? Effect.fail(notFound("readFileString", path))
				: Effect.succeed(text);
		},
		makeDirectory: (path) => {
			directories.push(path);

			return Effect.void;
		},
		writeFileString: (path, data) => {
			options.beforeWrite?.(path, files);
			if (path === options.failWrite) return Effect.fail(notFound("writeFileString", path));
			if (path === options.failWriteOnce && !failedOnce) {
				failedOnce = true;
				return Effect.fail(notFound("writeFileString", path));
			}
			if (path === options.partialWrite?.path && !partialWritten) {
				partialWritten = true;
				files.set(path, options.partialWrite.contents);
				return Effect.fail(notFound("writeFileString", path));
			}
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
		directories,
		provide: Effect.provideService(FileSystem.FileSystem, fs),
	};
};
