import type { Order } from "effect";

/** Compares strings by Unicode code point. */
export const compareCodePoints = (a: string, b: string) => {
	const left = Array.from(a);
	const right = Array.from(b);
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
		if (difference !== 0) return difference;
	}

	return left.length - right.length;
};

/** Turns a numeric comparison into an `Order` result. */
export const ordering = (difference: number): -1 | 0 | 1 =>
	difference < 0 ? -1 : difference > 0 ? 1 : 0;

/** Orders strings by Unicode code point. */
export const byCodePoint: Order.Order<string> = (a, b) => ordering(compareCodePoints(a, b));

/** Replaces backslashes with `/`. */
export const toPosix = (path: string) => path.replaceAll("\\", "/");

/**
 * Whether a glob pattern stays under the root: it is relative and has no `..`
 * segment.
 */
export const isContainedPattern = (pattern: string) => {
	const posix = toPosix(pattern);
	if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return false;

	return !posix.split("/").includes("..");
};

/** Swaps the case of every letter, to probe whether a file system ignores case. */
export const swapCase = (text: string) =>
	Array.from(text, (char) => {
		const lower = char.toLowerCase();

		return char === lower ? char.toUpperCase() : lower;
	}).join("");
