/**
 * Per-file transforms.
 *
 * @since @next
 */
export * as File from "./file.ts";
/**
 * Per-project transforms.
 *
 * @since @next
 */
export * as Project from "./project.ts";
export type { Edits, FileEdit, NameForm, TextEdit } from "./edits.ts";
export {
	type AdapterCause,
	causes,
	CompilerFailed,
	type CompilerStage,
	EditRejected,
	type Errors,
	type Failure,
	type GuardedError,
	ReadFailed,
	type ReadReason,
	SyntaxErrors,
	TransformFailed,
	UnknownError,
	WriteFailed,
	type WriteStatus,
} from "./errors.ts";
export { Workspace } from "./workspace.ts";
