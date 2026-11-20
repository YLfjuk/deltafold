import { ByteSize, Effect, FileSystem, Option, PlatformError } from "effect";

const notFound = (method: string, path: string) =>
	PlatformError.systemError({
		_tag: "NotFound",
		module: "FileSystem",
		method,
		description: "No such file",
		pathOrDescriptor: path,
	});

const info = (type: FileSystem.File.Type): FileSystem.File.Info => ({
	type,
	mtime: Option.none(),
	atime: Option.none(),
	birthtime: Option.none(),
	dev: 0n,
	ino: Option.none(),
	mode: 0o644,
	nlink: Option.none(),
	uid: Option.none(),
	gid: Option.none(),
	rdev: Option.none(),
	// The walker reads only `type`; ByteSize has no stable constructor.
	// @effect-diagnostics-next-line unstableApiUsage:off
	size: ByteSize.zero,
	blksize: Option.none(),
	blocks: Option.none(),
});

/** A directory path as a key prefix: "" for the working directory, otherwise ending in "/". */
const prefixOf = (path: string) => {
	if (path === "/") return "/";
	const trimmed = path.replace(/\/+$/, "");
	return trimmed === "" || trimmed === "." ? "" : `${trimmed}/`;
};

const isAbsoluteKey = (key: string) => key.startsWith("/") || /^[A-Za-z]:\//.test(key);

/**
 * A file system held in a map. Directories are implied by file paths, and `glob` is
 * Effect's own walker over them. Options inject faults: a write that fails without
 * touching the file, a write that leaves partial contents and then fails, and a hook that
 * runs before each write, for simulating another writer.
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
	const children = (path: string) => {
		const prefix = prefixOf(path);
		const entries = new Map<string, FileSystem.File.Type>();
		for (const key of files.keys()) {
			if (prefix === "" ? isAbsoluteKey(key) : !key.startsWith(prefix)) continue;
			const [name = "", ...rest] = key.slice(prefix.length).split("/");
			entries.set(name, rest.length === 0 ? "File" : "Directory");
		}
		return entries;
	};
	// Effect's default glob walks these directory listings.
	const { glob } = FileSystem.make({
		...FileSystem.makeNoop({}),
		stat: (path) => {
			if (files.has(path)) return Effect.succeed(info("File"));

			return children(path).size > 0
				? Effect.succeed(info("Directory"))
				: Effect.fail(notFound("stat", path));
		},
		readDirectoryEntries: (path) => {
			const entries = children(path);

			return entries.size === 0
				? Effect.fail(notFound("readDirectoryEntries", path))
				: Effect.succeed([...entries].map(([name, type]) => ({ name, type })));
		},
	});
	const fs = FileSystem.makeNoop({
		glob,
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
	});

	return {
		files,
		directories,
		provide: Effect.provideService(FileSystem.FileSystem, fs),
	};
};
