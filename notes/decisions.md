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
  tag; tag the release commit with `git tag <package>@<version> <commit>`, push
  the tag, and create its GitHub release.
- **API reference generation.** Generated API docs with `@effect/docgen` are
  deferred. A trial with Effect 4.1.2 type-checked `@example` blocks with
  TypeScript 7 and wrote Markdown docs. `@effect/docgen` requires `@since` on
  every public export, so released exports carry their release version and
  unreleased additions carry `@since @next`.
- **The `deltafold` bin.** `@deltafold/cli` declares its bin in
  `vite.config.ts` as `pack.exports.bin` and excludes the entry from `exports`,
  so importing the package never runs the CLI. It ships no types, so its pack
  config skips attw. `@effect/platform-node` brings a required `redis` peer.

## Integrations

- **Codemod packages.** Each codemod engine ships as its own package that returns
  ordinary handlers, so the core stays free of codemod engines and file formats.
  The first is `@deltafold/typescript`. A shared engine-agnostic package can follow
  once several packages repeat the same globs, file locks, temporary-file writes,
  and text edits.
- **TypeScript alias.** `@deltafold/typescript` depends on TypeScript 7.1.0-beta
  under the npm alias `typescript-7.1`, because 7.0 has no snapshot API. The build
  and test tools take `typescript` as a peer, so a second version under that name
  would give the package a second copy of the test runner. The alias goes when the
  catalog moves to a stable TypeScript with this API.
- **Targets.** Payloads name files with globs relative to the run's root, never
  tsconfig files, because a package author cannot know a consumer's layout.
  Matching never enters `node_modules`, because migrations change the developer's
  code, not installed packages.
- **Writes per action.** Each action writes its files when its transforms finish,
  so `Completed` means the files are on disk. Handlers see no migration
  boundaries, and writing once per migration would let the report and the disk
  disagree. File locks only narrow concurrency; `Action.parallel` still states
  that branches are independent.

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
- `deltafold self` is the migrator for the deltafold library, so the top level
  stays free for commands that work on the user's repository.
- Each package exports its `Package` from `<package>/delta`, starting with
  `deltafold/delta`.
- `migrate` runs on explicit versions with no confirmation flag, and manual work
  has no non-interactive confirmation.
- CLI JSON keeps every change metadata key and replaces values that JSON cannot
  hold with a type marker such as `[Date]`, without a serialization library.

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
  The CLI therefore runs `Executor.runPromise` with an abort signal, so a
  cancelled `migrate` still prints its partial report.
- Route identifiers contain `>`, `[`, and `]`, which shells interpret. The
  CLI quotes them in suggested commands; the JSON `argv` is exact.
- Suggested commands start with the full command path that ran the migrator,
  such as `deltafold self`. effect/cli passes that path to command handlers as an
  undocumented second argument; a mounted-command test fails if it stops doing so.
- Promise handlers that write to stdout mix with CLI results.

## Not yet implemented

- A helper that composes one migration from smaller parts, deferred until a
  concrete need appears.
- Opt-in retry and rollback that keep the original failure and partial report.
- A logging capability for handlers and adapters, filtered by log level.
- A durable executor (see the durability trial above).
- Supplying handlers through Effect layers.
- Explicit dependencies between migrations (`requires`).
- Runtime payload schemas, validation of imported histories, and serialized
  plans.
- A core-owned versioned JSON format for plans and reports, with payloads, and
  a plan fingerprint. The CLI's `schemaVersion` 1 documents omit payloads.
- Machine-readable CLI help and a published schema for the CLI's JSON documents.
- A preview mode for integration engines, distinct from dry runs.
- Branch labels in histories and an optional metadata schema.
- Retrying a TypeScript action after a write conflict with a new snapshot.
  Transforms only return edits, so rerunning them is safe.
- A shared `@deltafold/typescript` helper that finds a symbol, such as member `a1`
  of export `A`, once real migrations settle how it treats aliases, re-exports,
  and missing modules.

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
- How the `deltafold` bin mounts migrators for its other packages once they
  declare histories. `@deltafold/cli` could migrate references to renamed
  commands, such as in `AGENTS.md`, and `@deltafold/release` could migrate its own
  changes. One proposal is `deltafold cli` and `deltafold release`, but
  `deltafold release` would collide with release commands in the same bin.
- Whether generated API docs are committed or only produced in CI.
