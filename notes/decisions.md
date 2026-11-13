# deltafold decisions and limitations

This file records the design decisions behind the [requirements](requirements.md),
the provisional choices that still need confirmation, known limitations, work
that is not done yet, and open questions. Usage is in the
[package README](../packages/deltafold/README.md).

## Model

**Three relationships.** Release ancestry, migration routes, and handler bindings
are separate. A version's `previous` records ancestry only. Migrations register
independently, so routes can be added after a release without changing its
definition. Handlers bind to action instances, never to change records.

**Changes versus addresses.** `Version.changes` is release membership.
`Migration.addresses` lists the changes a transition handles. Both reference the
same change records. A matching change identifier never deduplicates action
execution.

**Headless changes.** A change carries consumer-defined `metadata`, such as a
classification, a breaking flag, or a version bump. deltafold stores and
compares it but assigns it no meaning. `Change.make(id)` declares a change
without metadata, `Change.make(id, metadata)` infers the metadata type, and
`Change.define<Metadata>()` returns a factory that requires one metadata type.
Relationships (`reverts`, `backportOf`) are a separate argument, so they never
collide with metadata field names. Changelog sections select changes through
their metadata, and the default changelog lists all changes in one "Changes"
section. Release logic stays outside the core: reading bumps, choosing a
version, finding pending changes, assigning them to a release, and publishing.
The core models membership (`Version.changes`), migration coverage
(`Migration.addresses`), and ancestry (`previous`).

**No route is not no work.** A missing route fails as `UnsupportedRoute`.
`Migration.noop` is the only way to declare a supported zero-work transition. A
migration with no prose and no actions, including one whose groups are all
empty, is a validation error. A skipped precondition is an execution outcome,
not a noop.

**Templates.** Migration, instruction, and change templates remove the common
indentation and the blank first and last lines. Content stays structured: text,
mentions, and occurrence-declaring steps in template order. The interpolation
style follows the
[public example](assets/alchemy-agent-reference.jpg) kept in `notes/assets`.

**Occurrence identity.** A declared occurrence's identifier is
`<migration>/<action>` or `<migration>/revert/<action>`. It survives prose edits
because it does not depend on position. A replacement's identifier is
`<rule>(<replaced occurrence ids joined by +>)/<action>`, so chained replacements
nest. Each migration side declares an action at most once.

**Validation.** `History.make` never throws. `History.validate` returns every
issue, sorted by tag, subject, and message, and resolution fails with
`InvalidHistory` while any issue remains.

## Routing

**One migration per transition.** At most one migration side goes from one
version to another. A second one, including another migration's revert, is a
`DuplicateEdge` validation issue that asks for the work to be merged. Work for
several files or formats lives in one migration, and `Migration.instruction`
keeps its prose per action. Alternatives are different version paths or
shortcuts. A helper that composes one migration from parts can follow when a
concrete need appears.

**No detours.** A route never mixes moves toward ancestors with moves toward
descendants in release ancestry. Explicit cross-branch migrations may appear in
either kind of route. A backport therefore reaches another branch only through a
migration declared from the backport itself.

**Route identifiers.** A route identifier is the version identifiers joined by
`>`, with shortcut hops written as `[shortcut-id]`, for example
`2.0.1>[fast-upgrade]>2.0.8`. Candidates are enumerated with Effect's `Graph`
module.

**Explicit selection.** When several candidates exist and neither `route` nor a
`policy` picks exactly one, resolution fails with `AmbiguousRoute`. The error
lists each candidate's identifier, migrations, shortcuts, optimized action count,
and cost. Policies choose by action count, migration count, declared cost, or
shortcut substitution. `prefer-shortcuts` only drops a route that another
candidate reproduces with a shortcut; unrelated routes stay ambiguous.

**Closest alternatives.** For an unsupported request, "closest" is the reachable
version with the smallest distance to the target in the ancestry tree. Ties are
all listed. Blockers are the ancestry hops with no declared edge, or the detour
that a route would need.

## Optimization

**Rules are assertions.** deltafold checks a rule's structure and use; it cannot
prove that consumer behavior is equivalent. Ordinary rules match consecutive
occurrences on the route's sequential spine, including across migration
boundaries, and inside one parallel branch. A parallel pattern matches a whole
group by its branch structure, which makes a structural rule explicit. A
text-only migration is manual work, so rules do not match around it.

**Exhaustive rewriting.** The resolver searches one state space for the whole
route. A state is the full sequence, nested groups included, and each transition
applies one rule at one position, either on the spine or inside a branch.
Branch-local and whole-group rewrites therefore compete. More than one distinct
final state is `ConflictingRewrites`; returning to an earlier state is
`RewriteCycle`. Different rule paths that reach the same actions are accepted.

**Search limits.** Resolution enumerates at most 100 candidate routes
(`TooManyRoutes`). One optimization explores at most 10 000 states and chains at
most 256 rule applications (`RewriteLimitExceeded`, with the limit that was
reached). Rules that keep nesting groups hit the same limits.

**Replacement placement.** A replacement belongs to the step of the first
occurrence it replaced, and the guide renders it there.

## Handlers and execution

**Promise adapter.** `Handler.promise` calls `Effect.tryPromise` with a thunk that
declares its `signal` parameter, because Effect only allocates an
`AbortController` when the thunk's `length` is non-zero. Declared services are
resolved before each call. `signal` is reserved and rejected as a service name at
compile time.

**Error matching.** `errors` accepts schemas and type guards. A guard must
annotate its parameter, for example `(cause: unknown) => cause instanceof X`;
TypeScript then infers the type predicate. Pass a schema itself rather than
`Schema.is(schema)`, whose generic signature defeats inference. Unrecognized
rejections become `UnexpectedHandlerError`.

**Static coverage.** A plan resolved from a history carries the history's whole
action union, because the route is chosen at run time. The executors constrain
the handler array directly: an action without a handler makes the `handlers`
option a type error that names the action. `Plan.withRuntimeCoverage` marks the
plan's coverage as run-time in its type, which removes that constraint and keeps
the action types. Run-time coverage still runs before any action starts.

**Handlers come from one array.** Handlers are supplied only through the
`handlers` array. Their Effect services stay ordinary requirements of the
execution. Supplying handlers through Effect layers is deferred until a consumer
needs handler selection through layers.

**Failure and interruption.** A failure stops admission of new actions; running
actions settle normally. A timeout interrupts only the action that exceeded it,
and its siblings settle as after a failure. Cancellation interrupts every
running action, and a body whose precondition was running when cancellation
arrived does not start. Admission stops as soon as a timeout or cancellation
fires, before the interrupted work finishes settling. Effect stops waiting for an
interrupted Promise immediately, so the adapter waits up to `settleTimeout` for
the Promise itself and the report records whether it settled.

**Cancellation per executor.** `Executor.effect` uses fiber interruption, so
cancelling it ends the effect as interrupted, without a report.
`Executor.runPromise` accepts an `AbortSignal` at the Promise boundary and turns
an abort into `ExecutionInterrupted` with the partial report. Its listener is
removed when the run ends.

**Dry runs.** A dry run evaluates a precondition only when no earlier action in
the same dependency chain would or might have run. Earlier migrations count as
dependencies of later ones, and parallel branches depend only on work before the
group. Branches are evaluated one at a time so reports are deterministic. After a
failed check, later checks are `Undetermined`. Timeouts and cancellation apply
to dry-run preconditions as they do to real runs.

## Documents

**Semantic layer over mdast.** deltafold owns sections with identifiers,
insertion points, release scoping, and automatic heading levels. The renderers in
`src/renderers` lower documents to mdast and rely on mdast-util-to-markdown,
mdast-util-to-hast, and hast-util-to-html for formatting and escaping. mdast
covered every structure the changelog needs. `deltafold/changelog` does not load
those serializers.

**Links.** Lowering keeps relative URLs and `http`, `https`, and `mailto` URLs,
and replaces any other URL with an empty one, using
micromark-util-sanitize-uri.

**Section identifiers.** Section identifiers are unique within their release or
document. Sections that deltafold generates use identifiers with the reserved
`deltafold/` prefix, so they never collide with version, migration, or
configured section identifiers. `Document.Section` rejects that prefix.

**Plugins.** Plugin scopes are `Document.Release` and `Document.History`.
Insertion points are `Document.Title.pre`, `Document.Title.post`,
`Document.Body.pre`, and `Document.Body.post`. Each insertion point receives the
contributions of all plugins at once, in configuration order. Content at the
title anchors is nested at the same depth as the section body.

**Metadata.** Builders match `Version.withMetadata` annotations to versions by
identifier and throw `ReleaseMetadataError` for duplicate, missing, or unrelated
annotations. The configured metadata type defines required fields; core imposes
none.

## Durability trial

This records a trial from November 2026 with Effect 4.1.2 on Node.js 24. Later
releases may behave differently.

A scratch probe ran Effect workflows with ClusterWorkflowEngine, SingleRunner,
SQL runner storage, and `@effect/sql-sqlite-node` (built on `node:sqlite`). It
ran three activities and exited after the second activity's side effect, before
its result was stored, then resumed.

- The first activity replayed from storage; the second ran again. Stored results
  are reused, but a step interrupted between its side effect and its record
  repeats. External writes are not exactly-once.
- Recording a "started" marker activity before each body let the resumed
  workflow detect the interrupted step and fail instead of repeating it.
- Resuming with a changed activity name ran the new definition without error.
  deltafold would need to store a plan fingerprint and compare it on resume.
- Activities retried interruptions up to 10 times by default.
  `interruptRetryPolicy: Schedule.recurs(0)` disabled that.
- The workflow and cluster modules were marked unstable, and the SQLite client
  and digest layer are Node-specific.

A durable executor would belong in an optional Node.js entry point or package.
It would run each occurrence as a guarded activity, store the plan fingerprint
and route first, fail on uncertain steps with an explicit recovery choice, and
keep stop-on-failure.

## Tooling and releases

**Packaging.** The package compiles with `lib: ES2022` and no DOM or Node types,
so source uses Effect's `Array` and `Order` modules for non-mutating sorts.
Minimal `AbortSignal` declarations for the package live in
`packages/deltafold/@types`; tests declare the rest in `test/@types`. Entry points
are named in the package's `pack.entry`, and the packer writes the matching
`exports`.

**Source layout.** `src/foundation` holds the shared model: actions, changes,
versions, migrations, instructions, rules, shortcuts, templates, and plans.
`src/features` holds capabilities. Planning covers history validation, route
resolution, rewrites, and guides. Execution covers handlers, the executor, and
settlement. Documents covers documents, sections, and changelogs. `package.ts`
is a single file until it needs more. A helper used by one feature stays in that
feature. `src/renderers` lowers documents for the `markdown` and `html` entry
points. Ambient declarations live in `@types` folders.

**Unstable Effect APIs.** Route planning and validation use `effect/Graph`, and
release ordering uses `effect/SemVer`. Effect marks both modules unstable. The
specific functions used are listed in `allowedUnstableApis` in
`tsconfig.base.json`, so a new unstable API still produces a diagnostic.

**TypeScript 7.** tsdown emits declarations with TypeScript 7 and warns that its
API is experimental. If declaration output regresses, fall back to TypeScript 6
for declaration emit.

**Publishing.** No release workflow, npm token, or publish step is configured.
The 0.0.0 placeholder was published manually. Publishing must go through pnpm,
which applies `publishConfig.exports`.

**Changelogs.** Changesets versions the package with its default changelog
formatter. A Changesets changelog plugin formats one line per changeset, so it
cannot express deltafold sections or resolved guides. The intended integration
sets `"changelog": false` and lets a deltafold step render `CHANGELOG.md` from
the package history, with release metadata passed as `Version.withMetadata`
annotations. GitHub Releases need a release workflow with write permissions.

**API reference.** Generated API docs with `@effect/docgen` are deferred. A trial
with version 4.1.2 type-checked `@example` blocks with TypeScript 7 and wrote
Markdown docs. It requires `@since` on every export, which is why exports carry
`@since @next` until the first release version is known.

## Provisional choices

These work today but need confirmation before 1.0:

- Ambiguous routes fail by default, including when a new shortcut adds a second
  candidate.
- Repeated action interpolation in one migration side is a validation error.
- Plans carry the history's whole action union for static coverage, so
  `Executor.runPromise` on a resolved plan needs handlers for every action in the
  history unless the plan uses `Plan.withRuntimeCoverage`.
- A cross-migration replacement belongs to the step of its first replaced
  occurrence.
- `settleTimeout` defaults to 5 seconds.
- `Migration.noop(id, { reversible: true })` declares a reverse zero-work
  transition.
- `changelog.upgrade` renders downgrade plans too, titled "Downgrade".
- History documents list releases newest first by semver when every identifier
  parses, and in reverse registration order otherwise. A standalone release has
  no package wrapper, and drafts are titled "Unreleased".
- Serializer dependencies are pinned to exact versions.

## Limitations

- Progress is not persisted. Rerunning a plan repeats completed actions.
- A failed action may have partly changed external state. Reports never claim it
  was rolled back.
- Signals are cooperative. A Promise callback that ignores its signal can keep
  changing state after cancellation.
- Change descriptions are plain text; Markdown in them is escaped.
- Change metadata is checked only by TypeScript. deltafold compares it
  structurally but does not validate it at run time.
- Merge ancestry and prerelease policy are not modeled.
- A false precondition only skips its own action. An unmet requirement that must
  block later actions has to fail its precondition.

## Not yet implemented

- The command-line interface (CLI-1 to CLI-4), deferred until the library has
  settled.
- Opt-in retry and rollback that keep the original failure and partial report.
- A logging capability for handlers and adapters, filtered by log level.
- A durable executor (see the durability trial).
- Supplying handlers through Effect layers.
- Explicit dependencies between migrations (`requires`).
- Runtime payload schemas, validation of imported histories, and serialized
  plans.
- A versioned JSON report format and a plan fingerprint.
- A preview mode for integration engines, distinct from dry runs.
- Branch labels in histories and an optional metadata schema.

## Open questions

- Should `prefer-shortcuts` become the default route policy?
- Should a repeated interpolation declare a second occurrence with a positional
  identifier instead of failing validation?
- Is whole-history static coverage the right default for Promise users?
- Should the optional durable executor be built, and in which package?
- How should `requires` dependencies behave when rules remove or replace actions?
- Which retry and rollback configuration, undo order, and recovery after a
  partially failed body?
- What logging bridge do Promise callbacks receive?
- Whether to ship optional change classification presets, such as changelog
  sections that read conventional metadata fields, and which fields they use.
- Downgrade guide naming.
- CLI packaging: a separate `@deltafold/cli` package, or `deltafold/cli` with
  `deltafold/cli/node`. TypeScript entry loading, option spellings, and the
  exit-code taxonomy.
- Whether codemod integrations ship as an official submodule, separate packages,
  or third-party packages.
- Which runtime versions the published library supports.
- Whether generated API docs are committed or only produced in CI.
