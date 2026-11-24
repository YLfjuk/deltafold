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
export type {
	AdapterCause,
	CompilerStage,
	Errors,
	Failure,
	GuardedError,
	ReadReason,
	WriteStatus,
} from "./errors.ts";
export {
	causes,
	CompilerFailed,
	EditRejected,
	ReadFailed,
	SyntaxErrors,
	TransformFailed,
	WriteFailed,
} from "./errors.ts";
export { Workspace } from "./workspace.ts";
