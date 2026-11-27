import { Data, Schema } from "effect";

import type { Handler } from "deltafold";
import * as PackageConfig from "./configs/package.ts";
import type { Info } from "./project.ts";

/**
 * The handler refused the edits for a file: an edit outside the text, overlapping
 * edits, an edit to a file the transform may not change, a name position that
 * `edit.rename` does not support, or edited JSON that no longer parses.
 *
 * @since @next
 */
export class EditRejected extends Data.TaggedError(`${PackageConfig.name}/EditRejected`)<{
	readonly path: string;
	readonly reason: string;
	readonly ranges: ReadonlyArray<{ readonly pos: number; readonly end: number }>;
}> {
	override get message() {
		return `Edits for ${this.path} were rejected: ${this.reason}`;
	}
}

/**
 * The file's transform did not run. A project transform does not run while any of its
 * matched files has syntax errors.
 *
 * @since @next
 */
export class SyntaxErrors extends Data.TaggedError(`${PackageConfig.name}/SyntaxErrors`)<{
	readonly path: string;
	readonly messages: ReadonlyArray<string>;
}> {
	override get message() {
		return `${this.path} has syntax errors`;
	}
}

/**
 * `path` is missing for a project transform's own error and for an edit to a file
 * outside its project.
 *
 * @since @next
 */
export type Failure<C> = {
	readonly project: Info;
	readonly path?: string;
	readonly cause: C;
};

/**
 * `Handler.UnexpectedHandlerError` wraps an error that no guard recognized, or an
 * Effect transform's defect.
 *
 * @since @next
 */
export type AdapterCause = Handler.UnexpectedHandlerError | EditRejected | SyntaxErrors;

/**
 * No file was written. Every transform runs before the action fails, so `failures`
 * lists all of them, sorted by path and project.
 *
 * @since @next
 */
export class TransformFailed<out E = never> extends Data.TaggedError(
	`${PackageConfig.name}/TransformFailed`,
)<{
	readonly actionId: string;
	readonly root: string;
	readonly failures: ReadonlyArray<Failure<E | AdapterCause>>;
}> {
	override get message() {
		const count = this.failures.length;

		return `${count} transform${count === 1 ? "" : "s"} of action "${this.actionId}" failed`;
	}
}

/**
 * Returns the failures whose cause the guard recognizes.
 *
 * @since @next
 */
export const causes = <E, G extends Handler.ErrorGuard>(
	error: TransformFailed<E>,
	guard: G,
): ReadonlyArray<Failure<GuardedError<G>>> =>
	error.failures.filter((failure): failure is Failure<GuardedError<G>> =>
		Schema.isSchema(guard) ? Schema.is(guard)(failure.cause) : guard(failure.cause),
	);

/**
 * The type a schema or type guard recognizes.
 *
 * @since @next
 */
export type GuardedError<G> = G extends Schema.Top
	? G["Type"]
	: G extends ((cause: unknown) => cause is infer E)
		? E
		: never;

/**
 * `"not-written"` means the original is unchanged.
 *
 * @since @next
 */
export type WriteStatus = "not-written" | "unknown";

/**
 * `pendingPaths` were not attempted. A file that changed since it was read fails here
 * before any file is replaced. Nothing is rolled back.
 *
 * @since @next
 */
export class WriteFailed extends Data.TaggedError(`${PackageConfig.name}/WriteFailed`)<{
	readonly actionId: string;
	readonly root: string;
	readonly writtenPaths: ReadonlyArray<string>;
	readonly failed: {
		readonly path: string;
		readonly status: WriteStatus;
		readonly reason: string;
		readonly cause?: unknown;
	};
	readonly pendingPaths: ReadonlyArray<string>;
}> {
	override get message() {
		return `Writing ${this.failed.path} for action "${this.actionId}" failed: ${this.failed.reason}`;
	}
}

/**
 * `"pattern"` covers absolute patterns, `..` segments, and matches outside the root.
 * `"changed"` means the file changed while the compiler loaded it.
 *
 * @since @next
 */
export type ReadReason = "pattern" | "link" | "unreadable" | "changed";

/**
 * No transform ran.
 *
 * @since @next
 */
export class ReadFailed extends Data.TaggedError(`${PackageConfig.name}/ReadFailed`)<{
	readonly actionId: string;
	readonly root: string;
	readonly path: string;
	readonly reason: ReadReason;
	readonly cause?: unknown;
}> {
	override get message() {
		return `Reading ${this.path} for action "${this.actionId}" failed (${this.reason})`;
	}
}

/** @since @next */
export type CompilerStage = "snapshot" | "request";

/**
 * Nothing restarts the compiler after it fails.
 *
 * @since @next
 */
export class CompilerFailed extends Data.TaggedError(`${PackageConfig.name}/CompilerFailed`)<{
	readonly actionId: string;
	readonly root: string;
	readonly stage: CompilerStage;
	readonly cause: unknown;
}> {
	override get message() {
		return `The TypeScript compiler failed during ${this.stage} for action "${this.actionId}"`;
	}
}

/** @since @next */
export type Errors<E> = TransformFailed<E> | WriteFailed | ReadFailed | CompilerFailed;
