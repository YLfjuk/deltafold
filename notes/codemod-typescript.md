# Codemod handlers with the TypeScript API

This note records the design of `@deltafold/typescript`, the first codemod
integration package, in `packages/typescript`. It builds handlers on the
TypeScript 7.1 compiler API. Requirements are in [requirements](requirements.md)
and core decisions in [decisions](decisions.md).

## Scope

The package returns ordinary `Handler` values. Actions stay tagged intentions
with explicit payloads, and the core gains no codemod engine, registry, or
file-format knowledge (EXEC-3, NFR-2). Plans can mix these handlers with custom
`Handler.promise` and `Handler.effect` handlers.

Integration packages are organized by how a codemod expresses its changes, not by
the file formats it touches. This package starts with one engine. An
engine-agnostic `@deltafold/mod` follows once several packages repeat the same
plumbing: root and globs, file locks, temporary-file writes, and applying text
edits. None of that plumbing depends on a file format, so another engine, such as
one that delegates edits to an agent, can reuse it.

## Representative migration

Every engine decision was tested against one migration. It renames the
`createClient` export of `@acme/widgets` to `makeClient` and renames the
`timeout` configuration key to `requestTimeout`.

The fixtures cover:

- ESM named and aliased imports
- an unrelated module that exports the same name
- a shadowed local and mentions in strings and comments
- re-exports such as `export { createClient } from "@acme/widgets"`
- CommonJS destructuring and namespace member access
- `await import()`
- a `.ts` file with an angle-bracket assertion and a `.tsx` file in a second
  package
- a file with a syntax error
- CRLF line endings, a UTF-8 BOM, and non-ASCII text
- JSONC and TypeScript configuration files

The rename uses an alias at the import (`import { makeClient as createClient }`),
so it needs no scope analysis and a second run changes nothing.

A second migration exercises type tracking. It renames the field `a1` of an
interface `A` exported by `@acme/widgets` to `a2` wherever a value of type `A`
is used, whatever the variables are called. Its fixtures span two packages with
their own tsconfig files and cover values that reach a file through re-exports,
`export *`, inferred return types, class fields, `Map<string, A>`, aliases,
destructuring, and a relative import from the other package.

## TypeScript dependency

The package uses the TypeScript 7.1 API (`typescript/async` and `typescript/ast`).
TypeScript 7.1.0-beta is a regular dependency of the package until 7.1 is
stable. The workspace catalog and the core package stay on 7.0.2, whose
`typescript/unstable/*` API lacks snapshots, per-file project discovery, and
disposable API objects.

The dependency is installed under the npm alias `typescript-7.1`, and the source
imports `typescript-7.1/async` and `typescript-7.1/ast`. The package's build and
test tools are peers of `typescript`; a second version under that name would
give the package its own copy of the test runner, apart from the copy the Effect
test helpers use. The alias goes away when the catalog moves to a TypeScript
version with this API.

The JavaScript client starts the bundled native compiler as a child process and
talks to it over a pipe. The package therefore keeps that client behind a Node
entry point, `@deltafold/typescript/node`. The main entry point exports only
platform-neutral services and types.

Observed behavior of 7.1.0-beta that the design depends on:

- `createSnapshot({ openFiles })` assigns each file to the tsconfig that contains
  it, with `extends` applied, from a repository root or a package root. A file
  outside every tsconfig gets an inferred project.
- One file that cannot be loaded fails the whole snapshot request.
- After a write, `snapshot.update` with file notifications returned stale text,
  while a new `createSnapshot` returned current text.
- `SourceFile.text` omits a leading BOM.
- A string value for an enum compiler option, such as `jsx: "preserve"`, crashed
  the native process.
- The public API has no helper for applying edits. Language-service methods such
  as `getImportAdderEdits` return `{ pos, end, newText }` edits.
- Parsing a standalone JSON file with `createSourceFile` returns no syntax
  diagnostics. A JSON file opened in a snapshot gets an inferred project, and its
  program reports syntax errors for it.
- A new snapshot reads current file contents even without file notifications.
- A `.jsonc` file in `openFiles` fails the snapshot with "no project found". The
  Node compiler therefore opens it as a hidden `.json` name next to it, whose text
  the snapshot's file-system layer supplies, and maps that name back to the file.
  Nothing is written under that name.

## Handlers

The package has two pairs of constructors. `TypeScript.File.promise` and
`TypeScript.File.effect` run a transform once per matched file.
`TypeScript.Project.promise` and `TypeScript.Project.effect` run it once per
TypeScript project. Each module also holds its types, such as
`TypeScript.File.Context` and `TypeScript.Project.Info`. The constructors follow
the argument order of `Handler.promise` and `Handler.effect`:

```ts
import { TypeScript } from "@deltafold/typescript";
import { TypeScriptNode } from "@deltafold/typescript/node";

const handler = TypeScript.File.promise(
	renameCreateClient,
	async ({ sourceFile, checker, edit, payload, signal }) => [
		edit.replace(specifier, "makeClient as createClient"),
	],
	{ include: ({ include }) => include },
);

await Executor.runPromise(plan, {
	handlers: [handler],
	services: TypeScriptNode.layer({ root: projectDirectory }),
});
```

All four use the asynchronous client. The syntax tree arrives in JavaScript and is
walked synchronously. Checker and program calls are awaited, so cancellation and
timeouts can act between them. The `promise` constructors pass an `AbortSignal`,
accept optional `services` and `errors`, and pass resolved services under
`services`, as `Handler.promise` does. The `effect` constructors keep their own
errors and services.

The handler requires one service, `TypeScript.Workspace`, which holds the root,
the file locks, and the compiler. `TypeScriptNode.layer({ root })` provides it
together with Node's file system. The compiler process starts with the first
snapshot and stops when the layer's scope closes.

## Targets

Payloads name files with globs relative to the root of a run. Package authors
cannot know a consumer's layout, so payloads never name tsconfig files. The run
supplies the root. A tool migration runs once at the repository root, and a
library migration runs once per package, because packages can depend on
different versions. One handler works for both.

Migrations change the developer's code, never installed packages. Matching never
enters `node_modules`, whatever the globs say. The compiler still reads installed
type declarations, so transforms can resolve symbols from them.

The adapter matches the globs under the root, refuses paths that resolve outside
it, and refuses symbolic links and junctions, including directories reached while
matching. It sorts files by code point and reports `/`-separated paths relative to
the root. It checks that each file can be loaded before opening it in the
compiler.

Who decides whether a migration runs per repository or per package, and how a run
finds each package's installed version, is not part of this package. That belongs
to the package declaration and the command-line interface.

## Transforms and edits

A file transform runs once per matched file and returns edits for that file only:
`ReadonlyArray<{ pos, end, newText }>`. This is the shape the TypeScript language
service returns, so a transform can return its own edits together with edits from
`getImportAdderEdits`. The `edit` helpers (`replace`, `remove`, `insertBefore`,
and `insertAfter`) take nodes and start at the first token, because a node's `pos`
includes leading comments and whitespace.

Rules for applying a batch:

- Offsets are UTF-16 positions in the file text without its BOM.
- All edits in a batch refer to the text the transform received, and the adapter
  applies them together.
- An edit outside the text, or two overlapping edits, rejects the batch and names
  both ranges. Identical edits that replace or remove text (same `pos`, `end`,
  and `newText`) are kept once instead. Identical insertions are all kept.
- At one offset, insertions come before a replacement, in the order returned.
- A helper given a node from another file throws.
- The adapter restores the BOM and leaves line endings unchanged.
- JSON and JSONC files are parsed with the TypeScript parser. A file with syntax
  errors is rejected before editing. The edited text must still parse in the
  original's dialect: strict JSON stays strict, and JSON with comments or trailing
  commas must still parse as such. JSON moves to a separate package only if this
  check proves unreliable.

`magic-string` is the alternative if edit objects prove too limited. It uses the
same original-offset model, adds anchoring rules for insertions, and fails at the
conflicting call.

## Project transforms

Some migrations need the whole project at once. Finding every use of a field
through the compiler's find-references is one search per project, and its
results span many files. A project transform runs that search once:

```ts
const handler = TypeScript.Project.promise(
	renameA1,
	async ({ payload, program, checker, references, edit }) => {
		const member = await findMember({ program, checker }, payload);
		if (member === undefined) return [];
		return (await references(member)).map((ref) => edit.rename(ref.node, payload.to));
	},
	{ include: ({ include }) => include },
);
```

The adapter groups the matched files by the project the compiler assigns to
each, and calls the transform once per project. A file belongs to exactly one
project, its default project, so no file is edited twice. References are
resolved in that project only. Files outside every tsconfig form an inferred
project. Their transform runs too, and `project` tells the transform which kind
it received.

The context holds:

- `project`: a configured project with its root-relative tsconfig path, or an
  inferred project with a stable identifier
- `files`: the project's matched files as root-relative paths, which are also the
  only files the transform may edit
- `sourceFile(path)`: loads one of those files on demand
- `program` and `checker`, which can read every file of the project, including
  installed type declarations
- `references(symbol)`: find-references limited to `files`; hits in installed
  packages, unmatched files, and other projects' files are left out
- `edit`: the same helpers as file transforms

The Promise variant returns Promises from `sourceFile` and `references`; the
Effect variant returns Effects that fail with `UnknownError`.

Each edit carries the root-relative path of its file:
`{ path, pos, end, newText }`. The helpers take the path from the node. The
adapter groups edits by file and applies the batch rules above to each file. An
edit to a file outside `files` fails the action.

`edit.rename(name, newName)` renames a property or member at a name node, such as
`reference.node`. It keeps local names in shorthand forms, so
`const { a1 } = value` becomes `const { a2: a1 } = value`, and it keeps the
quotes in `value["a1"]`. A name position it does not support fails with
`EditRejected` instead of a text replacement. Each reference carries its `form`,
so a transform can branch on it.

Locating the symbol, such as member `a1` of export `A` of `@acme/widgets`, is
the migration's own code for now. A transform should fail when the module is
found but the export or member is missing, so a broken migration cannot pass as
having nothing to change. A shared lookup helper can follow once real migrations
settle its behavior for aliases, re-exports, and missing modules.

Find-references does not see every use. A migration has to handle these itself
or document them, and the package README lists them:

- an object literal that spreads a value and sets the old key, such as
  `{ ...value, a1: 2 }`, which still compiles after the rename but no longer
  overrides the field
- a value whose type is a union, such as `A | B`
- string literals typed as `keyof A`
- generic code constrained by shape, such as `<T extends { a1: number }>`, which
  the compiler reports after the rename
- values typed `any`

## Locks, snapshots, and writes

A handler locks every file it may write before it reads them, in sorted order, so
two handlers cannot deadlock. The locks are an Effect `RcMap` of semaphores keyed
by canonical path, case-folded on case-insensitive file systems. They are taken
in the prepare phase and held in the occurrence's scope until the occurrence
ends, so no other handler of this package changes the files between the prepare
and apply phases. They coordinate handlers of this package, and custom handlers
can opt in with `workspace.lock(paths)`. Paths are normalized before they become
keys, waiting for a lock can be interrupted, and locks are not reentrant. `Action.parallel` stays the author's assertion that
branches are independent, because rules and dry runs depend on it. The locks only
narrow concurrency.

The handler creates a new compiler snapshot after it holds its locks, so it sees
writes from earlier actions, including custom ones. The snapshot closes when the
prepare phase ends. Each matched file's text in the snapshot must equal the
content the handler read; otherwise the action fails with `ReadFailed`. The checker can still read
files the handler has not locked. Because writes rename a complete file into
place, those reads see either the old or the new content.

Each action writes its files when its transforms finish, in three passes:

1. Write a temporary file next to each changed file.
2. Check that every original still matches the content that was read.
3. Rename each temporary file over its original.

A failure in the first two passes leaves every original unchanged. A file can
still change between its check and its rename, and a rename can still fail
partway through, so `WriteFailed` reports which files were written. The write
step cannot be interrupted, and it runs under the action's locks. Temporary
files have a recognizable suffix that no glob matches, and a scoped finalizer
removes them. Transforms only return edits and never receive a way to write. A
Promise transform that keeps running after an interrupt therefore cannot change
files.

`Completed` means the files are on disk, so the report and the disk agree. A
failure in a later migration leaves exactly the completed actions applied.
Nothing is rolled back, and progress is not saved (EXEC-10, NFR-6).

Flushing once per migration was considered and rejected for now. A handler cannot
observe migration boundaries. A layer finalizer cannot report a failed flush
through the run's errors. Deferred writes would also let the report and the disk
disagree. It can be revisited if the core gains a signal for step boundaries.

## Errors

- `TransformFailed<E>` means no file of the action was written. The adapter runs
  every transform of the action, then fails once. Its `failures` list every
  failure with its `project` and its `cause`, sorted. A failure of a file
  transform also carries the file's `path`. Optional `errors` guards or schemas,
  in `Handler.promise` syntax, keep matched causes as they are. Unmatched causes
  are wrapped in the tagged `TypeScript.UnknownError`. Without guards, the cause
  type is `UnknownError`. The `effect` constructors use their own `E | UnknownError`, and
  defects become `UnknownError`. `TypeScript.causes(error, guard)` returns the
  matching entries. Every transform can also fail with the adapter's own causes:
  `SyntaxErrors` for a matched file that does not parse, which fails by default,
  and `EditRejected` for edits the adapter refuses.
- `WriteFailed` lists the written paths, the failed path with a status of
  `"not-written"` or `"unknown"`, and the pending paths. A failure before the
  first rename lists every other file as pending. A content conflict at
  write time is a `WriteFailed`.
- `ReadFailed` covers matching and reading before any transform runs: a pattern
  that is absolute or leaves the root, a symbolic link or junction, an unreadable
  file, or a file whose compiler text differs from the content read.
- `CompilerFailed` covers a failed spawn, a missing native package, a protocol
  error, and a crash. The adapter sends no compiler options of its own and never
  restarts the compiler.

`TypeScript.Errors<E>` is the union of these errors for a transform that declares
`E`.

Every error carries the action identifier and the root, and its causes are plain
data. Per-file results of successful actions are not reported in the first
release.

## Dry runs

The handlers use the core's prepare and apply phases. The prepare phase matches,
locks, reads, runs the transforms, and computes the new file contents; it writes
nothing. It skips with "No files match the include patterns" or "No matched file
would change". The apply phase writes the prepared contents. The prepared value
is internal to the package and stays out of `Handler<A, E, R>`.

A dry run therefore reports whether any matched file would change, or which
transforms fail, without writing. Like every dry run, it reflects the files as
its prepare phases saw them: it does not apply earlier actions, so a later real
run may compute different edits.

## Deferred

- An engine preview that runs handlers against an in-memory overlay that is never
  written, and returns diffs.
- Resuming a run from a recorded checkpoint.
- Retrying an action after a write conflict: take a new snapshot, rerun its
  transforms, and write again, up to a limit. Transforms only return edits, so
  rerunning them has no side effects.
- Reporting per-file results through execution observers.
- A run helper such as `TypeScriptNode.runPromise(plan, { root, handlers })`.
- A shared symbol lookup helper, once real migrations settle its behavior.
- A migration, built with this package, that upgrades handlers written for
  deltafold 0.0.1 to the prepare and apply phases of 0.1, together with the API
  changes between those releases. Its scope is to be agreed before it is built.
