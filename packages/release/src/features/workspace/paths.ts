import { issue, type Issue } from "../../foundation/error.ts";

// Path arithmetic on forward-slash paths. An absolute path keeps its prefix: "/" on POSIX,
// "C:/" for a Windows drive (the letter is upper-cased), or "//" for a UNC share.

const prefixOf = (path: string): string => {
	const slashed = path.replace(/\\/g, "/");
	const drive = /^([A-Za-z]):\//.exec(slashed);
	if (drive?.[1] !== undefined) return `${drive[1].toUpperCase()}:/`;
	if (slashed.startsWith("//")) return "//";
	if (slashed.startsWith("/")) return "/";

	return "";
};

const driveRelative = (path: string) => /^[A-Za-z]:(?![\\/])/.test(path);

/** Whether a path is absolute on POSIX or Windows. */
export const isAbsolute = (path: string): boolean => prefixOf(path) !== "";

/**
 * Removes `.` segments, resolves `..`, and joins with "/". An absolute path keeps its
 * prefix, and `..` never climbs above it. A relative path keeps leading `..` segments.
 */
export const normalize = (path: string): string => {
	const prefix = prefixOf(path);
	const body = path
		.replace(/\\/g, "/")
		.slice(prefix === "" ? 0 : prefix === "/" ? 1 : prefix.length);
	const parts: Array<string> = [];
	for (const part of body.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
			else if (prefix === "") parts.push(part);
			continue;
		}
		parts.push(part);
	}

	return `${prefix}${parts.join("/")}`;
};

/** Joins path parts. An absolute part restarts the path. */
export const join = (...parts: ReadonlyArray<string>): string => {
	let path = "";
	for (const part of parts) {
		if (part === "") continue;
		path = isAbsolute(part) || path === "" ? part : `${path}/${part}`;
	}

	return normalize(path);
};

export const dirname = (path: string): string => {
	const normalized = normalize(path);
	const prefix = prefixOf(normalized);
	const body = normalized.slice(prefix.length);

	return `${prefix}${body.split("/").slice(0, -1).join("/")}`;
};

/**
 * The path from one directory to a target, as a module specifier: it starts with `./` or
 * `../`. Both paths must be relative, or absolute with the same prefix.
 */
export const relative = (fromDirectory: string, to: string): string => {
	const from = normalize(fromDirectory);
	const target = normalize(to);
	const prefix = prefixOf(target);
	const fromParts = from
		.slice(prefixOf(from).length)
		.split("/")
		.filter((part) => part !== "");
	const targetParts = target.slice(prefix.length).split("/");
	let shared = 0;
	while (
		shared < fromParts.length &&
		shared < targetParts.length - 1 &&
		fromParts[shared] === targetParts[shared]
	)
		shared++;
	const path = [...fromParts.slice(shared).map(() => ".."), ...targetParts.slice(shared)].join(
		"/",
	);

	return path.startsWith(".") ? path : `./${path}`;
};

/**
 * Where release files are found.
 *
 * @since @next
 */
export type Location = {
	/**
	 * The workspace root. Absolute paths must stay inside it, and reports show paths
	 * relative to it. Defaults to the working directory; pass an absolute root to accept
	 * absolute paths.
	 */
	readonly root?: string;
	/**
	 * The directory relative paths resolve against: the release config file's directory.
	 * Relative to `root`, or absolute inside it. Defaults to `root`.
	 */
	readonly base?: string;
};

/** A resolved location with workspace-relative helpers. */
export type Paths = {
	/** A path given relative to `base`, or absolute, as a workspace-relative path. */
	readonly fromBase: (path: string) => string | Issue;
	/** A path given relative to the workspace root, or absolute, as a workspace-relative path. */
	readonly fromRoot: (path: string) => string | Issue;
	/** The path the file system receives for a workspace-relative path. */
	readonly toFs: (path: string) => string;
};

const sameDrive = (a: string, b: string) => prefixOf(a) === prefixOf(b);

const segments = (path: string) => {
	const normalized = normalize(path);
	return normalized
		.slice(prefixOf(normalized).length)
		.split("/")
		.filter((part) => part !== "");
};

/**
 * The path of `path` inside `directory`, segment by segment: "" for the directory itself,
 * and `undefined` when `path` is not inside it.
 */
const within = (directory: string, path: string): string | undefined => {
	const outer = segments(directory);
	const inner = segments(path);
	if (inner.length < outer.length || outer.some((part, index) => inner[index] !== part)) {
		return undefined;
	}

	return inner.slice(outer.length).join("/");
};

export const paths = (location: Location = {}): Paths => {
	const root = normalize(location.root ?? "");
	const outside = (path: string) =>
		issue(
			"OutsideWorkspace",
			root === "" || !isAbsolute(root)
				? `${path} is absolute, but no absolute workspace root was given to check it against.`
				: `${path} is outside the workspace root ${root}.`,
			[path],
		);
	const inWorkspace = (given: string, path: string): string | Issue => {
		// "C:dir" is relative to drive C's current directory, not to the workspace.
		if (driveRelative(given)) {
			return issue(
				"OutsideWorkspace",
				`${given} is relative to a drive's current directory; use a workspace-relative or absolute path.`,
				[given],
			);
		}
		if (isAbsolute(path)) {
			if (!isAbsolute(root) || !sameDrive(root, path)) return outside(given);
			const rel = within(root, path);
			return rel === undefined ? outside(given) : rel;
		}
		const rel = normalize(path);
		// Only an actual parent segment leaves the workspace; "..cache" is an ordinary name.
		return rel === ".." || rel.startsWith("../") ? outside(given) : rel;
	};
	const baseDir = location.base === undefined ? "" : location.base;
	const base = isAbsolute(baseDir) ? baseDir : join(isAbsolute(root) ? root : "", baseDir);
	const baseRel = inWorkspace(baseDir, base);

	return {
		fromBase: (path) => {
			if (typeof baseRel !== "string") return baseRel;

			return isAbsolute(path)
				? inWorkspace(path, path)
				: inWorkspace(path, join(baseRel, path));
		},
		fromRoot: (path) => inWorkspace(path, path),
		toFs: (path) => (root === "" ? normalize(path) : join(root, path)),
	};
};
