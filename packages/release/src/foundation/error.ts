import { Data } from "effect";

import * as PackageConfig from "../configs/package.ts";

/**
 * Why planning or preparation refused a release.
 *
 * @since 0.0.1
 */
export type Reason =
	| "GroupId"
	| "DuplicatePackage"
	| "OutsideGroup"
	| "MissingMember"
	| "UnknownPrevious"
	| "PreviousRequired"
	| "NoPrevious"
	| "InvalidVersion"
	| "InvalidBump"
	| "InvalidPre"
	| "InvalidInput"
	| "InvalidStrategyResult"
	| "StrategyRefused"
	| "NotAStrategy"
	| "InvalidPolicyResult"
	| "UnsupportedRange"
	| "StaleRequirement"
	| "StaleSource"
	| "MissingSelection"
	| "BaselineMismatch"
	| "Downgrade"
	| "ExistingVersion"
	| "PrereleaseTarget"
	| "NoIntent"
	| "PrereleaseContext"
	| "NotPrerelease"
	| "MissingSource"
	| "UnplannedPending"
	| "UnsupportedRelocation"
	| "NameCollision"
	| "MissingPreviousSource"
	| "VersionFileExists"
	| "VersionFileName"
	| "InvalidVersionIndex"
	| "SharedVersionsDirectory"
	| "ManifestMismatch"
	| "OutsideWorkspace"
	| "ReplacementConflict";

/** @since 0.0.1 */
export type Issue = {
	readonly reason: Reason;
	readonly message: string;
	/** Package names, version ids, change ids, or paths the issue is about. */
	readonly subjects: ReadonlyArray<string>;
};

/** @since 0.0.1 */
export const issue = (reason: Reason, message: string, subjects: ReadonlyArray<string> = []) => ({
	reason,
	message,
	subjects,
});

/**
 * Nothing was read or written.
 *
 * @since 0.0.1
 */
export class PlanError extends Data.TaggedError(`${PackageConfig.name}/PlanError`)<Issue> {}

/**
 * Lists every independent problem found during resolution or preparation. Nothing was
 * written.
 *
 * @since 0.0.1
 */
export class PrepareError extends Data.TaggedError(`${PackageConfig.name}/PrepareError`)<{
	readonly issues: ReadonlyArray<Issue>;
}> {}

/**
 * Files that the prepared release read have changed since preparation. Nothing was
 * written; prepare the release again and review the new result.
 *
 * @since 0.0.1
 */
export class StalePlan extends Data.TaggedError(`${PackageConfig.name}/StalePlan`)<{
	readonly paths: ReadonlyArray<string>;
}> {}

/**
 * Applying failed part way. The files this operation changed were restored where they
 * still held its contents. A file holding anything else, which may be another writer's
 * change or a partial write by the failed operation, is left as it is and listed in
 * `unrestored` with `ChangedDuringApply`.
 * Directories created for new files are kept. Restoration is best effort and does not
 * survive a crash.
 *
 * @since 0.0.1
 */
export class ApplyFailed extends Data.TaggedError(`${PackageConfig.name}/ApplyFailed`)<{
	readonly path: string;
	readonly cause: unknown;
	readonly restored: ReadonlyArray<string>;
	readonly unrestored: ReadonlyArray<{ readonly path: string; readonly cause: unknown }>;
}> {}

/**
 * A file changed while apply was running, so apply left it as it was.
 *
 * @since 0.0.1
 */
export class ChangedDuringApply extends Data.TaggedError(
	`${PackageConfig.name}/ChangedDuringApply`,
)<{
	readonly path: string;
}> {}
