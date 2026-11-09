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
text-only migration holds prose instructions, so rules do not match around it.

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

**Manual handlers.** `Handler.manual` binds an action to a person instead of a
body. Who performs an action is a property of the binding, never of the action,
so `Action` and `Migration` have no manual marker. The handler carries no
instruction text: the interaction receives the plan's occurrence, whose
instruction or description is the text the guide renders. `Handler.manual` takes
Promise checks and `Handler.manualEffect` takes Effect checks.

**Interaction.** The `interaction` executor option is the only way to answer for
manual work. Its answers are `"confirmed"` and `"declined"`; any other value
from a Promise interaction fails the occurrence. The check for a missing
interaction runs after handler coverage and before any precondition, and counts
manual occurrences whose precondition might later skip them. When the consumer
can ask a person is the consumer's decision. Observers report progress and
cannot answer.

**Manual phases.** A manual occurrence runs `when`, then the `confirmation`
phase, then `verification` when the handler has a `verify` check. `verify` never
runs before the confirmation and is never retried. A check that returns `false`
fails with `VerificationFailed`. A decline stops admission like a failure and
ends the run as `ExecutionFailed` with status `failed`; the occurrence is
`Declined`. `bodiesStarted` becomes true when a person is asked. Cancellation
that arrives with the confirmation keeps `verify` from starting, and the
occurrence is `Interrupted` in `verification`. After a sibling fails, an
occurrence whose precondition already passed still asks, as a body would still
run.

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

## Observation

**Attachment.** `Package.withObserver` returns a new package with the observer
appended; the original keeps its observers. The package only carries them. The
executor's `observers` option takes a plain array, usually `pkg.observers`, and
the executor has no knowledge of packages. Observers run in array order. The
observers' Effect services join the execution's requirements.

**Delivery.** The executor waits for every observer before it continues, and
delivers one event at a time across parallel branches, so each run has one total
order and the final event arrives before the execution settles. Counters change
in the same critical section, so progress never decreases. A thrown value, a
rejection, or an Effect failure is recorded in `report.observation` with the
observer's position and the event, and that observer still receives later
events. Observation never changes outcomes or status. Before a cancellation or
timeout, deliveries have no time limit, so a hanging observer stalls the run.
After one, each delivery waits at most `settleTimeout` and is then abandoned and
recorded; a Promise observer's `signal` aborts. When the fiber of
`Executor.effect` is interrupted, a finalizer sends one `RunFinished` without a
report, bounded the same way.

**Steps and provenance.** Step progress counts steps that keep actions after
optimization, plus prose-only steps, which settle at once as `prose` because the
executor runs nothing for them and does not wait at them. Noop steps and steps
whose actions rules removed or moved are `omitted`: `RunStarted` lists them, but
progress does not count them. A replacement runs in the step of the first occurrence it replaced, as
before. Its `sources` name the declared steps behind it, and that step's
`absorbs` names the other steps whose work it performs, so a failure there shows
that a later step's declared work was already attempted. `Plan.Step.id` is the
migration identifier, followed by `/revert` for a reverse migration.

**Event contents.** Events hold identifiers, descriptions, and outcome tags. Each
outcome summary copies its fields explicitly, so a field added to the report's
outcome reaches observers only after review. A failed outcome keeps only the
error's string `_tag`; typed errors and causes stay in the report. Manual outcomes
keep their performer and confirmation, which hold no input from the person.
Action descriptions reach observers and must not hold secrets. `ActionSettled`
arrives once for each occurrence with an outcome, and as `Unattempted` for an
occurrence whose precondition passed but whose body or prompt did not start.
Handler coverage failures and `InteractionUnavailable` emit no events.

**Manual work.** The `confirmation` phase of `ActionPhaseStarted` is the signal
that a run is waiting for a person; no separate prompt events exist. Observers
receive events only and cannot answer a confirmation. `run.id` comes from the
optional `runId`; observers shared by concurrent runs need it to tell runs apart.

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

## Command-line interface

**A toolkit in core, a bin outside it.** `deltafold/cli` builds a package's
migrator command. It is platform independent and adds no dependency, because it
uses `effect/cli` from `effect`. The author's bin supplies the platform layer and
main runner. `@deltafold/cli` ships the `deltafold` bin, which is deltafold's
own migrator built with the toolkit; its Node.js code lives in
`src/domains/node`. It uses `@effect/platform-node`, whose required `redis` peer
is installed with it.

**An ordinary command.** `Cli.make` returns an `effect/cli` command that runs on
its own with `Cli.run` or mounts under another command. A tool that migrates
several packages mounts one command per package. `effect/cli` is marked unstable,
so `cli.command` follows its types. `Cli.run` adds usage-error reporting and
removes the interactive wizard; a mounted command keeps the parent's usage
handling.

**Commands.** `validate`, `plan`, `upgrades`, `downgrades`, `guide`, `migrate`
when handlers are supplied, and `changelog` when release metadata is supplied.
`--from` and `--to` are always required. `migrate` runs on explicit versions
without a confirmation flag; `--dry-run` previews. `--route` and `--policy` are
exclusive. `--action-timeout` is the executor's per-phase timeout, named so that
it is not mistaken for a total limit. Handlers are passed as a function so only
`migrate` loads them. The CLI uses run-time coverage, because handlers are
supplied as data; `Cli.make` still rejects handlers for actions outside the
package and carries their services in its type.

**Streams and formats.** Results go to stdout, everything else to stderr.
`--log-level` filters diagnostics only. Effect logs go to stderr. With `--json`,
stdout holds one document with `schemaVersion: 1`, diagnostics are dropped, and a
failure before any result prints one error document on stderr with `status`,
`reason`, `message`, `data`, and `next` (follow-up commands as `argv`, plus a
display string). `migrate` always prints its report on stdout. Usage errors that
stop parsing look for `--json` in the arguments. Color follows `--no-color`,
`NO_COLOR`, `FORCE_COLOR`, and whether the stream is a terminal; `TERM=dumb`
turns off rich output. Suggested commands use double quotes where they work in
POSIX shells, PowerShell, and cmd.

**Exit statuses.** 0 for success, 1 for operational failures, 2 for usage errors,
unknown versions or routes, and ambiguous routes (`action_required`), and 130 for
interruption. `NodeRuntime` reports SIGTERM as 130 as well. `validate` prints its
issues as the result and exits 1.

**Cancellation.** `migrate` runs the executor at the Promise boundary with an
abort signal. Interrupting the CLI fiber aborts it and waits for the partial
report, which is printed before the fiber ends as interrupted. The `deltafold`
bin exits at once on a second SIGINT.

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
settlement. Documents covers documents, sections, and changelogs. CLI builds a package's migrator command. `package.ts`
is a single file until it needs more. A helper used by one feature stays in that
feature. `src/renderers` lowers documents for the `markdown` and `html` entry
points. Ambient declarations live in `@types` folders.

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
- Change kinds are fixed to `added`, `changed`, `removed`, and `fixed`.
- Merge ancestry and prerelease policy are not modeled.
- A person's confirmation is not checked unless the handler has a `verify`
  check, and the report says which of the two supports a completion.
- A run that waits for a person holds no state outside its process. Stopping the
  process loses the wait with the rest of the progress.
- A false precondition only skips its own action. An unmet requirement that must
  block later actions has to fail its precondition.
- The executor does not wait at prose-only steps. Their instructions reach people
  through the guide and observer events only.
- Interrupting the fiber of `Executor.effect` produces no report. Observers
  receive a `RunFinished` event without one.
- Route identifiers contain `>`, `[`, and `]`, which shells interpret. The
  CLI quotes them in suggested commands; the JSON `argv` is exact.
- Suggested commands start with the migrator's name. Under a parent command they
  leave out the parent's path.
- Promise handlers that write to stdout mix with CLI results.

## Not yet implemented

- Opt-in retry and rollback that keep the original failure and partial report.
- A logging capability for handlers and adapters, filtered by log level.
- A durable executor (see the durability trial).
- Supplying handlers through Effect layers.
- Explicit dependencies between migrations (`requires`).
- Runtime payload schemas, validation of imported histories, and serialized
  plans.
- A core-owned versioned JSON format for plans and reports, with payloads, and
  a plan fingerprint. The CLI's `schemaVersion` 1 documents omit payloads.
- Machine-readable CLI help and a published schema for the CLI's JSON documents.
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
- Final change-kind vocabulary and downgrade guide naming.
- Should `--route` also accept a shortcut identifier, so that common route
  choices need no shell quoting?
- Whether codemod integrations ship as an official submodule, separate packages,
  or third-party packages.
- Which runtime versions the published library supports.
- Whether generated API docs are committed or only produced in CI.
