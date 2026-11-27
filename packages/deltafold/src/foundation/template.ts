import dedentText from "dedent";

const placeholder = "\u0000";

/**
 * Returns one dedented string per input literal so interpolated values stay at their
 * positions and are never stringified or re-indented.
 */
export const dedent = (strings: ReadonlyArray<string>): ReadonlyArray<string> =>
	dedentText(strings.join(placeholder)).split(placeholder);

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
