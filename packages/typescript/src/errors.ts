import { Data, Schema } from "effect";

import type { Handler } from "deltafold";
import type { Info } from "./project.ts";

/**
 * A transform threw or failed with a value that none of its error guards recognized,
 * or an Effect transform died. `cause` is the original value.
 *
 * @since @next
 */
export class UnknownError extends Data.TaggedError("UnknownError")<{
	readonly cause: unknown;
}> {
	override get message() {
		return "A transform failed with an unrecognized error";
	}
}

/**
 * The adapter refused the edits for a file: an edit outside the text, overlapping
 * edits, an edit to a file the transform may not change, a name position that
 * `edit.rename` does not support, or edited JSON that no longer parses.
 *
 * @since @next
 */
export class EditRejected extends Data.TaggedError("EditRejected")<{
	readonly path: string;
	readonly reason: string;
	readonly ranges: ReadonlyArray<{ readonly pos: number; readonly end: number }>;
}> {
	override get message() {
		return `Edits for ${this.path} were rejected: ${this.reason}`;
	}
}

/**
 * A matched file has syntax errors, so its transform did not run. A project
 * transform does not run while any of its project's matched files has them.
 *
 * @since @next
 */
export class SyntaxErrors extends Data.TaggedError("SyntaxErrors")<{
	readonly path: string;
	readonly messages: ReadonlyArray<string>;
}> {
	override get message() {
		return `${this.path} has syntax errors`;
	}
}

/**
 * One failure of a transform. `path` names the file when the failure concerns one: a
 * file with syntax errors, a failed file transform, or edits the adapter rejected for
 * that file. A project transform's own error, or an edit it returns for a file outside
 * its project, names only the project.
 *
 * @since @next
 */
export type Failure<C> = {
	readonly project: Info;
	readonly path?: string;
	readonly cause: C;
};

/**
 * The adapter's own failure causes, which every transform can produce.
 *
 * @since @next
 */
export type AdapterCause = UnknownError | EditRejected | SyntaxErrors;

/**
 * At least one transform of the action failed, and no file was written. Every
 * transform of the action runs before the action fails, so `failures` lists all of
 * them, sorted by path and project. `E` is the error type a transform declared.
 *
 * @since @next
 */
export class TransformFailed<out E = never> extends Data.TaggedError("TransformFailed")<{
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
 * Selects the failures of a `TransformFailed` whose cause a guard recognizes: a
 * schema, or a type guard.
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
 * Whether a file was written when the write step failed: `"not-written"` when its
 * original is unchanged, `"unknown"` when the failure left that unclear.
 *
 * @since @next
 */
export type WriteStatus = "not-written" | "unknown";

/**
 * Writing the action's files failed. `writtenPaths` were replaced, `failed` names the
 * file that failed, and `pendingPaths` were not attempted. A conflict found before
 * renaming, such as a file that changed after it was read, fails here before any file
 * is replaced. Nothing is rolled back.
 *
 * @since @next
 */
export class WriteFailed extends Data.TaggedError("WriteFailed")<{
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
 * Why a target could not be read: a pattern that is absolute or leaves the root, a
 * symbolic link or junction, a file that cannot be read, or a file that changed while
 * the compiler loaded it.
 *
 * @since @next
 */
export type ReadReason = "pattern" | "link" | "unreadable" | "changed";

/**
 * Matching or reading the action's files failed before any transform ran.
 *
 * @since @next
 */
export class ReadFailed extends Data.TaggedError("ReadFailed")<{
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

/**
 * The stage at which the compiler failed.
 *
 * @since @next
 */
export type CompilerStage = "snapshot" | "request";

/**
 * The TypeScript compiler failed: it could not start, its native package is missing,
 * a request failed, or it crashed. The adapter never restarts it.
 *
 * @since @next
 */
export class CompilerFailed extends Data.TaggedError("CompilerFailed")<{
	readonly actionId: string;
	readonly root: string;
	readonly stage: CompilerStage;
	readonly cause: unknown;
}> {
	override get message() {
		return `The TypeScript compiler failed during ${this.stage} for action "${this.actionId}"`;
	}
}

/**
 * The errors of a handler built by this package, for a transform that declares
 * errors `E`.
 *
 * @since @next
 */
export type Errors<E> = TransformFailed<E> | WriteFailed | ReadFailed | CompilerFailed;
