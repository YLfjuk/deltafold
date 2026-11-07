# deltafold decisions and limitations

This file records the design decisions behind the [requirements](requirements.md),
the provisional choices that still need confirmation, known limitations, and open
questions. Usage is in the [package README](../packages/deltafold/README.md).

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
`Migration.noop` is the only way to declare a supported zero-work transition, and
an ordinary migration with no content is a validation error. A skipped
precondition is an execution outcome, not a noop.

**Templates.** Migration, instruction, and change templates remove the common
indentation and the blank first and last lines. Content stays structured: text,
mentions, and occurrence-declaring steps in template order. The interpolation
style follows the public example in `assets/alchemy-agent-reference.jpg`.

**Occurrence identity.** A declared occurrence's identifier is
`<migration>/<action>` or `<migration>/revert/<action>`. It survives prose edits
because it does not depend on position. A replacement's identifier is
`<rule>(<replaced occurrence ids joined by +>)/<action>`, so chained replacements
nest. Each migration side declares an action at most once.

## Routing

**Complementary edges.** All migrations between the same two versions form one
edge and run in registration order, each as its own step. Alternatives are
different version paths or shortcuts. A reverse edge exists only when every
migration of the forward group has a revert. Otherwise the reverse group would
silently skip some consumers' work, so a blocker names the migrations without a
revert.

**No detours.** A route never mixes moves toward ancestors with moves toward
descendants in release ancestry. Explicit cross-branch migrations may appear in
either kind of route. A backport therefore reaches another branch only through a
migration declared from the backport itself.

**Route identifiers.** A route identifier is the version identifiers joined by
`>`, with shortcut hops written as `[shortcut-id]`, for example
`2.0.1>[fast-upgrade]>2.0.8`. Candidates are enumerated with Effect's `Graph`
module, up to 100 routes.

**Explicit selection.** When several candidates exist and neither `route` nor a
`policy` picks exactly one, resolution fails with `AmbiguousRoute`. The error
lists each candidate's identifier, migrations, shortcuts, optimized action count,
and cost. `prefer-shortcuts` only drops a route that another candidate reproduces
with a shortcut; unrelated routes stay ambiguous.

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

**Exhaustive rewriting.** The resolver explores every rule at every position
until no rule applies. More than one distinct result is `ConflictingRewrites`;
returning to an earlier state is `RewriteCycle`. Different rule paths that reach
the same actions are accepted. The search stops at 10 000 states or 256 chained
applications, reported as `RewriteLimitExceeded`.

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
action union, because the route is chosen at run time. Every action without a
handler in the array becomes a `Handler.Binding` requirement.
`Plan.withRuntimeCoverage` opts out of the static check. Run-time coverage still
runs before any action starts.

**Layer bindings.** `Handler.layer` captures the handlers' services when the
layer is built. The executor looks bindings up by action identifier, so it cannot
see a bound handler's error type; their failures arrive as `BoundHandlerError`
with the original error in `cause`.

**Failure and interruption.** A failure stops admission of new actions; running
actions settle normally. Explicit cancellation interrupts every running action.
A timeout interrupts only the action that exceeded it, and its siblings settle
as after a failure. Effect stops waiting for an interrupted Promise immediately,
so the adapter waits up to `settleTimeout` for the Promise itself and the report
records whether it settled.

**Dry runs.** A dry run evaluates a precondition only when no earlier action in
the same dependency chain would or might have run. Earlier migrations count as
dependencies of later ones, and parallel branches depend only on work before the
group. Branches are evaluated one at a time so reports are deterministic. After a
failed check, later checks are `Undetermined`.

## Documents

**Semantic layer over mdast.** deltafold owns sections with identifiers,
insertion points, release scoping, and automatic heading levels. It lowers them
to mdast and relies on mdast-util-to-markdown, mdast-util-to-hast, and
hast-util-to-html for formatting and escaping. mdast covered every structure the
changelog needs.

**Plugins.** Plugin scopes are `Document.Release` and `Document.History`.
Insertion points are `Document.Title.pre`, `Document.Title.post`,
`Document.Body.pre`, and `Document.Body.post`. Content at the title anchors is
nested at the same depth as the section body.

**Metadata.** Builders match `Version.withMetadata` annotations to versions by
identifier and throw `ReleaseMetadataError` for duplicate, missing, or unrelated
annotations. The configured metadata type defines required fields; core imposes
none.

## Durability investigation

A scratch probe ran Effect 4.1.2 workflows with ClusterWorkflowEngine,
SingleRunner, SQL runner storage, and `@effect/sql-sqlite-node` (built on
`node:sqlite`) on Node.js 24. It ran three activities and exited after the
second activity's side effect, before its result was stored, then resumed.

- The first activity replayed from storage; the second ran again. Stored results
  are reused, but a step interrupted between its side effect and its record
  repeats. External writes are not exactly-once.
- Recording a "started" marker activity before each body let the resumed
  workflow detect the interrupted step and fail instead of repeating it.
- Resuming with a changed activity name ran the new definition without error.
  deltafold would need to store a plan fingerprint and compare it on resume.
- Activities retry interruptions up to 10 times by default.
  `interruptRetryPolicy: Schedule.recurs(0)` disables that.
- The workflow and cluster modules are marked unstable, and the SQLite client and
  digest layer are Node-specific.

A durable executor would belong in an optional Node.js entry point or package.
It would run each occurrence as a guarded activity, store the plan fingerprint
and route first, fail on uncertain steps with an explicit recovery choice, and
keep stop-on-failure. It is not built.

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
- A false precondition only skips its own action. An unmet requirement that must
  block later actions has to fail its precondition.

## Open questions

- Should `prefer-shortcuts` become the default route policy?
- Should a repeated interpolation declare a second occurrence with a positional
  identifier instead of failing validation?
- Is whole-history static coverage the right default for Promise users?
- Should the optional durable executor be built, and in which package?
- How should `requires` dependencies behave when rules remove or replace actions?
- Which retry and rollback configuration, undo order, and recovery after a
  partially failed body?
- Should reports get a versioned JSON envelope and a plan fingerprint input to
  detect drift between inspection and execution?
- What logging bridge do Promise callbacks receive?
- Final change-kind vocabulary, downgrade guide naming, branch labels in
  histories, and an optional metadata schema.
- CLI packaging: a separate `@deltafold/cli` package, or `deltafold/cli` with
  `deltafold/cli/node`. TypeScript entry loading, option spellings, and the
  exit-code taxonomy.
- Whether codemod integrations ship as an official submodule, separate packages,
  or third-party packages.
