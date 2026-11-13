import { Data } from "effect";

/**
 * Why planning or preparation refused a release.
 *
 * @since @next
 */
export type Reason =
	| "GroupId"
	| "DuplicatePackage"
	| "OutsideGroup"
	| "MissingMember"
	| "UnknownPrevious"
	| "InvalidVersion"
	| "InvalidBump"
	| "InvalidPre"
	| "InvalidStrategyResult"
	| "BaselineMismatch"
	| "Downgrade"
	| "ExistingVersion"
	| "ExplicitTargetWithPre"
	| "NoIntent"
	| "PrereleaseContext"
	| "StablePromotionUnsupported"
	| "MissingSource"
	| "UnplannedPending"
	| "UnsupportedRelocation"
	| "NameCollision"
	| "MissingPreviousSource"
	| "VersionFileExists"
	| "ManifestMismatch"
	| "ReplacementConflict";

/**
 * A structured planning or preparation problem.
 *
 * @since @next
 */
export type Issue = {
	readonly reason: Reason;
	readonly message: string;
	/** Package names, version ids, change ids, or paths the issue is about. */
	readonly subjects: ReadonlyArray<string>;
};

/** @since @next */
export const issue = (reason: Reason, message: string, subjects: ReadonlyArray<string> = []) => ({
	reason,
	message,
	subjects,
});

/**
 * Planning refused the input. Nothing was read or written.
 *
 * @since @next
 */
export class PlanError extends Data.TaggedError("PlanError")<Issue> {}

/**
 * Preparation found problems. Every independent problem is listed, and nothing was
 * written.
 *
 * @since @next
 */
export class PrepareError extends Data.TaggedError("PrepareError")<{
	readonly issues: ReadonlyArray<Issue>;
}> {}

/**
 * Files that the prepared release read have changed since preparation. Nothing was
 * written; prepare the release again and review the new result.
 *
 * @since @next
 */
export class StalePlan extends Data.TaggedError("StalePlan")<{
	readonly paths: ReadonlyArray<string>;
}> {}

/**
 * Applying failed part way. The files this operation had already changed were
 * restored where possible. `unrestored` lists the files that could not be restored.
 * Restoration is best effort and does not survive a crash.
 *
 * @since @next
 */
export class ApplyFailed extends Data.TaggedError("ApplyFailed")<{
	readonly path: string;
	readonly cause: unknown;
	readonly restored: ReadonlyArray<string>;
	readonly unrestored: ReadonlyArray<{ readonly path: string; readonly cause: unknown }>;
}> {}
