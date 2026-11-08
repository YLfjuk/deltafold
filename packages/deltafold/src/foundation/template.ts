const placeholder = "\u0000";

/**
 * Removes the common indentation of a tagged template, and the blank first and last
 * lines that come from writing the template on its own lines.
 *
 * Returns one literal string per original literal, so interpolated values stay at their
 * positions.
 */
export const dedent = (strings: ReadonlyArray<string>): ReadonlyArray<string> => {
	const joined = strings.join(placeholder);
	const lines = joined.split("\n");

	if (lines.length > 1 && lines[0]?.trim() === "") lines.shift();
	if (lines.length > 1 && lines.at(-1)?.trim() === "") lines.pop();

	const indents = lines.flatMap((line) => {
		if (line.trim() === "") return [];

		return line.length - line.trimStart().length;
	});
	const indent = indents.length === 0 ? 0 : Math.min(...indents);

	return lines
		.map((line) => (line.trim() === "" ? "" : line.slice(indent)))
		.join("\n")
		.split(placeholder);
};

/** Scalar values that interpolate as text. */
export type Scalar = string | number | boolean | bigint;

export const isScalar = (value: unknown): value is Scalar =>
	typeof value === "string" ||
	typeof value === "number" ||
	typeof value === "boolean" ||
	typeof value === "bigint";

export const describeValue = (value: unknown): string => {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";

	return typeof value === "object" ? "an object" : typeof value;
};
