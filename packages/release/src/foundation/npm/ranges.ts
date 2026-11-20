import { Result, SemVer, SemVerRange } from "effect";

// Dependency ranges in the forms release planning can rewrite: `^x.y.z`, `~x.y.z`, and an
// exact `x.y.z`. `workspace:` ranges are resolved by the package manager at publish time.

export type Form =
	| { readonly _tag: "Workspace" }
	| {
			readonly _tag: "Rewritable";
			readonly operator: "^" | "~" | "";
			readonly version: SemVer.SemVer;
	  }
	| { readonly _tag: "Unsupported" };

export const form = (range: string): Form => {
	if (range.startsWith("workspace:")) return { _tag: "Workspace" };
	const match = /^([~^]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range.trim());
	const parsed = match?.[2] === undefined ? undefined : SemVer.parse(match[2]);
	if (match === null || parsed === undefined || Result.isFailure(parsed)) {
		return { _tag: "Unsupported" };
	}
	const operator = match[1] === "^" || match[1] === "~" ? match[1] : "";

	return { _tag: "Rewritable", operator, version: parsed.success };
};

/**
 * Whether a version satisfies a range, with npm range semantics: a prerelease satisfies
 * only a range with a prerelease on the same version, and build metadata is ignored. Any
 * range SemVer can parse is checked, including forms that cannot be rewritten; anything
 * else, such as a dist-tag, is not satisfied.
 */
export const satisfies = (range: string, version: string): boolean => {
	const parsed = SemVerRange.parse(range);
	const target = SemVer.parse(version);
	return (
		Result.isSuccess(parsed) &&
		Result.isSuccess(target) &&
		SemVerRange.matches(parsed.success, target.success)
	);
};

/** Keeps the range's operator and replaces its version. */
export const rewrite = (range: Form & { readonly _tag: "Rewritable" }, version: string): string =>
	`${range.operator}${version}`;
