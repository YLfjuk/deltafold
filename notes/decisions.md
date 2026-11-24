# deltafold decisions and open questions

This note tracks provisional choices awaiting 1.0 confirmation, operational
constraints, model limitations beyond the
[package README](../packages/deltafold/README.md), unbuilt work for the
[requirements](requirements.md), and open questions. Template interpolation
follows the [public example](assets/alchemy-agent-reference.jpg) kept in
`notes/assets`.

## Durability trial

This records a trial from November 2026 with Effect 4.1.2 on Node.js 24. Later
releases may behave differently.

A scratch probe ran Effect workflows with ClusterWorkflowEngine, SingleRunner,
SQL runner storage, and `@effect/sql-sqlite-node` built on `node:sqlite`. It
ran three activities, exited after the second activity's side effect before
storing its result, and resumed.

- The first activity replayed from storage and the second ran again. Stored
  results reuse prior work, while steps interrupted between their side effect
  and their record repeat. External writes are not guaranteed once.
- Recording a "started" marker activity before each body let the resumed
  workflow detect the interrupted step and fail instead of repeating it.
- Resuming with a changed activity name ran the new definition without error.
  deltafold would need to store a plan fingerprint and compare it on resume.
- Activities retried interruptions up to 10 times by default;
  `interruptRetryPolicy: Schedule.recurs(0)` disabled that.
- The workflow and cluster modules were marked unstable, and the SQLite client
  and digest layer are Node-specific.

A durable executor belongs in an optional Node.js entry point or package. It
would run each occurrence as a guarded activity, store the plan fingerprint and
route first, fail on uncertain steps with an explicit recovery choice, and keep
stop-on-failure.

## Tooling and release operations

- **TypeScript 7 declaration emit.** tsdown emits declarations with TypeScript
  7 and warns that its API is experimental. If declaration output regresses,
  fall back to TypeScript 6 for declaration emit.
- **Trusted publishing and tag recovery.** The publish job in
  `.github/workflows/release.yml` runs in the `npm-publish` GitHub environment.
  Repository settings restrict that environment to `main`, and npm's trusted
  publisher requires it. Because workflow YAML conditions can be edited on PR
  branches, those repository and npm settings, not the YAML alone, prevent
  unreviewed branches from publishing. If publishing succeeds but creating the
  release tag fails, reruns only publish missing versions and do not recreate the
  tag; tag the release commit with `git tag deltafold@<version> <commit>`, push
  the tag, and create its GitHub release.
- **API reference generation.** Generated API docs with `@effect/docgen` are
  deferred. A trial with Effect 4.1.2 type-checked `@example` blocks with
  TypeScript 7 and wrote Markdown docs. `@effect/docgen` requires `@since` on
  every public export, so released exports carry their release version and
  unreleased additions carry `@since @next`.

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

## Design limitations

- Change descriptions are plain text; Markdown in them is escaped.
- Change metadata is checked only at compile time. deltafold compares it
  structurally and does not validate it at run time.
- Core histories do not model merge ancestry or prerelease policy; those live in
  `@deltafold/release`.
- The executor does not wait at prose-only steps; their instructions reach
  people through guides and observer events only.
- Interrupting the fiber of `Executor.effect` produces no report. Observers
  receive a `RunFinished` event without one.

## Not yet implemented

- The command-line interface (CLI-1 to CLI-4), deferred until the library settles.
- A helper that composes one migration from smaller parts, deferred until a
  concrete need appears.
- Opt-in retry and rollback that keep the original failure and partial report.
- A logging capability for handlers and adapters, filtered by log level.
- A durable executor (see the durability trial above).
- Supplying handlers through Effect layers.
- Explicit dependencies between migrations (`requires`).
- Runtime payload schemas, validation of imported histories, and serialized plans.
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
  partially failed apply phase?
- What logging bridge do Promise callbacks receive?
- Whether to ship optional change classification presets, such as changelog
  sections that read conventional metadata fields, and which fields they use.
- Downgrade guide naming.
- CLI packaging: a separate `@deltafold/cli` package, or `deltafold/cli` with
  `deltafold/cli/node`, plus TypeScript entry loading, option spellings, and
  exit codes.
- Whether codemod integrations ship as an official submodule, separate packages,
  or third-party packages.
- Whether generated API docs are committed or only produced in CI.
