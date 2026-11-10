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
empty, is a validation error. An action skipped by its prepare phase is an
execution outcome, not a noop.

**Templates.** Migration, instruction, and change templates remove the common
indentation and the blank first and last lines. Content stays structured: text,
mentions, and occurrence-declaring steps in template order. The interpolation
style follows the
[public example](assets/alchemy-agent-reference.jpg) kept in `notes/assets`.

**Occurrence identity.** A declared occurrence's identifier is
`<migration>/<action>` or `<migration>/revert/<action>`. It survives prose edits
because it does not depend on position. A replacement's identifier is
`<rule>(<replaced occurrence ids joined by +>)/<action>`, so chained replacements
nest. A backslash escapes `\`, `/`, `(`, `)`, and `+` inside author identifiers,
so distinct occurrences never share an identifier and author identifiers need no
restrictions. Each migration side declares an action at most once.

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
migration declared from the backport itself. A declared shortcut is the
exception: its migrations may pass through a shared ancestor, because a shortcut
is the author's assertion that they are equivalent to the route it replaces. The
route that uses it is classified by the shortcut's own endpoints.

**Route identifiers.** A route identifier is the version identifiers joined by
`>`, with shortcut hops written as `[shortcut-id]`, for example
`2.0.1>[fast-upgrade]>2.0.8`. A backslash escapes `\`, `>`, `[`, and `]` inside
identifiers, so distinct routes never share an identifier. Candidates are
enumerated with Effect's `Graph` module.

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

**Fully optimized steps.** When rules remove every action of a step, the guide
omits the step, including prose written outside any `Migration.instruction`.
Advice that must survive optimization belongs in an action, for example one
with a manual handler.

## Handlers and execution

**Promise adapter.** `Handler.promise` calls `Effect.tryPromise` with a thunk that
declares its `signal` parameter, because Effect only allocates an
`AbortController` when the thunk's `length` is non-zero. Callbacks receive
`{ signal, services }`: declared services are resolved before each call and kept
apart from built-in fields, so no service name is reserved.

**Error matching.** `errors` accepts schemas and type guards. A guard must
annotate its parameter, for example `(cause: unknown) => cause instanceof X`;
TypeScript then infers the type predicate. Pass a schema itself rather than
`Schema.is(schema)`, whose generic signature defeats inference. Unrecognized
rejections become `UnexpectedHandlerError`.

**Prepare and apply phases.** A handler either applies its action directly or
declares `{ prepare, apply }`, and then needs both. `prepare` reads state and
returns `Handler.prepared(value)` or `Handler.skip(reason)`. The wrapper keeps
a skip apart from any prepared value, whatever its shape. `apply` receives the
value unchanged. The handler author defines the value; the executor never reads,
validates, or serializes it. Constructors infer the value and keep it inside the
handler, so handler arrays, coverage checks, and executor types see only
`Handler<A, E, R>`, with the errors and services of both phases. Promise phases
receive `prepare(payload, { signal, services })` and
`apply(prepared, { payload, signal, services })`; Effect phases receive
`prepare(payload)` and `apply(prepared, { payload })`. A prepare phase is
read-only by contract, not by sandbox. There is no separate precondition or
skip-reason option, and no ambient run-mode service: a handler cannot tell a
dry run from a real one.

**Occurrence scopes.** Each occurrence runs in its own scope, shared by both
phases and closed once when the occurrence ends, with an exit that reflects how
it ended. Effect handlers run in that scope and do not require `Scope`, so a
lock acquired while preparing stays open through `apply`. Promise callbacks get
no cleanup registration; adapters own the resources they acquire. A finalizer
that fails before the report fails an occurrence that otherwise ended normally.

**Interrupted Promises that outlive the report.** An interrupted Promise that
does not settle within `settleTimeout` is reported `settled: false`, and the
report is returned without waiting further. Its occurrence's scope, and a
services layer that `runPromise` built, stay open until the Promise settles,
possibly forever, and then close in that order. A prepare result that arrives
after interruption is discarded; `apply` never runs. A services context the
caller supplies stays the caller's to track and release. A cleanup failure
after the report cannot change it, so it is logged through Effect with the
occurrence or the services layer.

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
running action, and an occurrence whose prepare phase was running when
cancellation arrived does not apply. Each phase has its own `timeout` window.
An occurrence that started preparing before a sibling failed or timed out may
still apply. Admission stops as soon as a timeout or cancellation
fires, before the interrupted work finishes settling. Effect stops waiting for an
interrupted Promise immediately, so the adapter waits up to `settleTimeout` for
the Promise itself and the report records whether it settled.

**Manual handlers.** `Handler.manual` binds an action to a person. Who performs
an action is a property of the binding, never of the action, so `Action` and
`Migration` have no manual marker. A manual handler has no prepare or apply
phase, so it cannot skip: its step after the empty prepare is a confirmation.
It carries no instruction text. The interaction receives the plan's occurrence,
whose instruction or description is the text the guide renders.
`Handler.manual` takes a Promise `verify` check and `Handler.manualEffect` an
Effect one, which runs in the occurrence's scope.

**Interaction.** The `interaction` executor option is the only way to answer for
manual work. Its answers are `"confirmed"` and `"declined"`. Any other value
fails the occurrence with `UnexpectedInteractionError`, which never keeps the
value, because it may be text that the person typed. The check for a missing
interaction runs after handler coverage and before any handler phase. When the
consumer can ask a person is the consumer's decision. Observers report progress
and cannot answer.

**Manual phases.** A manual occurrence runs the `confirmation` phase, then
`verification` when the handler has a `verify` check. `verify` never runs before
the confirmation and is never retried. A check that returns `false` fails with
`VerificationFailed`. A decline stops admission like a failure and ends the run
as `ExecutionFailed` with status `failed`; the occurrence is `Declined`.
`bodiesStarted` becomes true when a person is asked. `timeout` limits
`verification` and never `confirmation`. Cancellation that arrives with the
confirmation keeps `verify` from starting, even after a sibling failure, and
the occurrence is `Interrupted` in `verification`. A failure or a decline in a
parallel branch does not withdraw a request that was already made.

**Cancellation per executor.** `Executor.effect` uses fiber interruption, so
cancelling it ends the effect as interrupted, without a report.
`Executor.runPromise` accepts an `AbortSignal` at the Promise boundary and turns
an abort into `ExecutionInterrupted` with the partial report. Its listener is
removed when the run ends.

**Dry runs.** A dry run runs a prepare phase only when no earlier action in
the same dependency chain would or might have run. Earlier migrations count as
dependencies of later ones, and parallel branches depend only on work before the
group. Branches are evaluated one at a time so reports are deterministic. A dry
run never runs `apply`. A failed preparation is `PreparationFailed`, and later
preparations are `Undetermined`. Handlers without a prepare phase are
`WouldExecute` without evaluation. Timeouts and cancellation apply to dry-run
prepare phases as they do to real runs. A dry run reflects the state that its
prepare phases saw; a later real run may see different state.

## Observation

**Run input.** Observers are an input of a run, like handlers. The executor's
`observers` option takes a plain array, and nothing is attached to the package,
which stays a model of the package's history. A command-line interface accepts
observers alongside handlers. Observers run in array order. The observers'
Effect services join the execution's requirements.

**Delivery.** The executor waits for every observer before it continues, and
delivers one event at a time across parallel branches, so each run has one total
order and the final event arrives before the execution settles. Counters change
in the same critical section, so progress never decreases. A thrown value, a
rejection, or an Effect failure is recorded in `report.observation` with the
observer's position and the event, and that observer still receives later
events. Observation never changes outcomes or status. Before a cancellation or
timeout, deliveries have no time limit, so a hanging observer stalls the run.
After one, each delivery waits at most `settleTimeout` and is then abandoned and
recorded; a Promise observer's `signal` aborts. An abandoned callback is
interrupted without waiting, because an Effect observer may not be interruptible,
and a services layer that `runPromise` built stays open until it stops. A Promise
observer stops only when its Promise settles, even if it ignores its `signal`. Admission is checked again after
each phase-start delivery, so a cancellation that arrives while observers are
notified keeps the phase from starting. When the fiber of `Executor.effect` is
interrupted, a finalizer sends one `RunFinished` without a report, bounded the
same way. If the interruption cuts short the delivery of `RunFinished`, the
observers that had not received it get the report-less one with the same `seq`.

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
error's string `_tag`, or none when reading it throws; typed errors and causes
stay in the report. Manual outcomes
keep their performer and confirmation, which hold no input from the person.
Action descriptions reach observers and must not hold secrets. `ActionSettled`
arrives once for each occurrence with an outcome, and as `Unattempted` for an
occurrence that started but stopped before applying or asking. Handler coverage
failures and `InteractionUnavailable` emit no events. `run.id` comes from the
optional `runId`; observers shared by concurrent runs need it to tell runs apart.

**Phases and settlement.** `ActionPhaseStarted` reports `prepare` only for
handlers with a prepare phase, then `apply`, or `confirmation` and `verification`
for manual work. An occurrence's outcome can still change when its scope closes,
because a failing finalizer fails it, so `ActionSettled` is sent after the scope
closes. When an unsettled interrupted Promise keeps the scope open, the outcome is
already final and later cleanup failures are only logged, so the event is sent
without waiting. A handler that interrupts itself stops admission like a failure,
and deliveries stay unbounded; only cancellation and timeouts bound them.

**Manual work.** The `confirmation` phase of `ActionPhaseStarted` is the signal
that a run is waiting for a person; no separate prompt events exist. Observers
receive events only and cannot answer a confirmation.

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
`deltafold/` prefix: fixed ones such as `deltafold/package`, and ones derived from
model identifiers as `deltafold/release/<version>`, `deltafold/step/<migration>`,
and `deltafold/revert/<migration>`. The kind contains no `/`, so any version or
migration identifier renders, and generated sections never collide with each
other or with configured sections. `Document.Section` rejects the prefix.

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

**An ordinary command.** `Command.make` returns an `effect/cli` command whose
requirements include the handlers' services. `Cli.run` runs any command as the
program, with the version it prints: it adds usage-error reporting and removes
the interactive wizard. `run` belongs to `Cli` because it applies to any
top-level command, and so that no deltafold function shares a name with
`effect/cli`'s `Command.run`. Code that composes commands imports `effect/cli`
under another name, such as `EffectCli`. A tool that migrates several packages
can mount one command per package, for example as `<cli> <package> <command>`,
where each package keeps its own versions and commands. Composers can arrange
commands differently.
`effect/cli` is marked unstable, so the command type follows it.

**Commands.** `validate`, `plan`, `upgrades`, `downgrades`, `guide`, `migrate`
when handlers are supplied, and `changelog` when release metadata is supplied.
`--from` and `--to` are always required. `migrate` runs on explicit versions
without a confirmation flag; `--dry-run` previews. `--route` and `--policy` are
exclusive. `--action-timeout` is the executor's per-phase timeout, named so that
it is not mistaken for a total limit. Handlers are passed as a function so only
`migrate` loads them. The CLI uses run-time coverage, because handlers are
supplied as data; `Command.make` still rejects handlers for actions outside the
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

**Progress.** `migrate` passes the package's observers to the executor and appends
an observer that writes step and action progress to stderr through the CLI's
output, so it follows `--log-level` and is left out with `--json`. It prints
steps that have actions, unnumbered, because the event step total also counts
steps without actions. Observer failures are warnings on stderr and plain fields
in the JSON report; their causes are never serialized whole.

**Manual handlers (planned).** Once core supports `Handler.manual`, `migrate`
supplies an interaction only when stdin and stderr are terminals, `--json` is not
set, and `CI` is not set. Without one, core refuses to start a run that has
manual occurrences, and the CLI exits 2 with `interaction_required`, listing them
and suggesting a terminal run or `--dry-run`. There is no non-interactive
confirmation, and `--yes` never confirms manual work. The prompt is plain line
input on stderr: it shows the occurrence and its instruction, and asks
"Did you complete it? (y/n)". Only `y`, `yes`, `n`, or `no` is accepted; anything
else asks again. `n` declines. Ctrl+C or the end of input cancels the run and
never counts as a decline. Prompts from parallel branches are asked one at a
time, and progress lines wait while a prompt is open. Text-only instructions are
not manual work and are never prompted for.

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

**Publishing.** Maintainers apply versions with `pnpm run version` in a pull
request. The release workflow builds, tests, and runs `changeset pack` on every
pull request as a publish dry run. On `main`, `changesets/action/publish` runs
`pnpm run release` (`changeset publish`), which publishes the versions npm does
not have yet with `pnpm publish`, so `publishConfig.exports` applies. It uses npm
trusted publishing, without a stored token, and creates release tags and GitHub
releases. The 0.0.0 placeholder was published manually.

The publish job runs in the `npm-publish` GitHub environment. Repository settings
allow that environment only on `main`, and npm's trusted publisher requires it.
The workflow's own conditions are editable on any branch, so the two settings,
not the YAML, keep unreviewed branches from publishing.

A rerun publishes only versions npm does not have yet. If publishing succeeds but
creating the release tag fails, a rerun does not recreate the tag. That case is
recovered by hand: tag the release commit with `git tag deltafold@<version>
<commit>`, push the tag, and create its GitHub release.

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
  transition. A revert added to a noop with `Migration.withRevert` is real work,
  so only the forward side is omitted.
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
- A person's confirmation is not checked unless the handler has a `verify`
  check, and the report says which of the two supports a completion.
- A run that waits for a person holds no state outside its process. Stopping the
  process loses the wait with the rest of the progress.
- A skip only skips its own action. An unmet requirement that must block later
  actions has to fail its prepare phase.
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
- A TypeScript codemod that migrates handlers from the removed `when` and
  `skipReason` options to `{ prepare, apply }`. The breaking release that removes
  those options needs it.

## Open questions

- Should `prefer-shortcuts` become the default route policy?
- Should a repeated interpolation declare a second occurrence with a positional
  identifier instead of failing validation?
- Is whole-history static coverage the right default for Promise users?
- Should the optional durable executor be built, and in which package?
- How should `requires` dependencies behave when rules remove or replace actions?
- Which retry and rollback configuration, undo order, and recovery after a
  partially failed apply phase?
- What logging bridge do Promise callbacks receive?
- Whether to ship optional change classification presets, such as changelog
  sections that read conventional metadata fields, and which fields they use.
- Downgrade guide naming.
- Should `--route` also accept a shortcut identifier, so that common route
  choices need no shell quoting?
- Should deltafold plan coordinated migrations for connected packages that are
  released together, with ordering across packages, one dry run, and one report?
  A multi-package command currently runs one package at a time.
- Whether codemod integrations ship as an official submodule, separate packages,
  or third-party packages.
- Which runtime versions the published library supports.
- Whether generated API docs are committed or only produced in CI.
