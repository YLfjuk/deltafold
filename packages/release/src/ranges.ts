import { Result, SemVer } from "effect";

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
 * Whether a version satisfies a rewritable range. A prerelease version satisfies only an
 * exact range naming it, so moving to a prerelease always edits the range.
 */
export const satisfies = (range: Form, version: SemVer.SemVer): boolean => {
	if (range._tag !== "Rewritable") return false;
	const base = range.version;
	if (range.operator === "") return SemVer.equals(base, version);
	if (SemVer.isPrerelease(version) || SemVer.isLessThan(version, base)) return false;
	if (range.operator === "~") return version.major === base.major && version.minor === base.minor;
	if (base.major > 0) return version.major === base.major;
	if (base.minor > 0) return version.major === 0 && version.minor === base.minor;

	return version.major === 0 && version.minor === 0 && version.patch === base.patch;
};

/** Keeps the range's operator and replaces its version. */
export const rewrite = (range: Form & { readonly _tag: "Rewritable" }, version: string): string =>
	`${range.operator}${version}`;
