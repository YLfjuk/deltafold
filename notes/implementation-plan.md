# deltafold implementation plan

Track tasks, decisions, and acceptance evidence here. Read [API design](api-design.md)
and [review findings](review-findings.md) before changing contracts. Design examples
are proposed syntax, not existing exports. Keep reference assets in notes/assets.

## Public repository hygiene

Track only project-relevant design and implementation information. Keep private
conversation links, session identifiers, absolute machine paths, personal contact
details, credentials, and orchestration instructions out of repository files and
commit metadata. Use repository-relative paths and a GitHub noreply commit email.

## Phase 1: repository baseline

Status: complete.

Public repository: <https://github.com/YLfjuk/deltafold>. The baseline contains the
MIT license, README, design notes, review findings, implementation plan, and public
reference image. No package has been published.

## Phase 2: set up the repository

Status: complete. The setup is merged to `main` through pull request #1.

The user published `deltafold@0.0.0` from `main` as a placeholder that reserves the
npm name, and then explicitly approved phase 3.

### Adopted toolchain

| Concern | Choice |
| --- | --- |
| Package manager | pnpm 12.18.0 (`packageManager`), workspace `packages/*` |
| Task ordering and cache | Turborepo 2.11.10: `build`, `typecheck`, `test` |
| Library packaging | Vite+ 1.5.0 `vp pack` (tsdown), ESM only, neutral platform, declarations, strict publint, attw (`esm-only` profile, error level) |
| Tests | Vite+ `vp test` (Vitest 5.1.0) with `@effect/vitest` 4.1.2 |
| Lint | Vite+ `vp lint` (Oxlint), type-aware with type checking |
| Format | Vite+ `vp fmt` (Oxfmt), options copied from the shared oxfmt template |
| Type checking | TypeScript 7.0.2 `tsc --noEmit`, strict base config |
| Effect | `effect` 4.1.2; the package declares `effect: ^4.1.2` as a peer dependency |
| Versioning | Changesets 3.0.3, public access, base branch `main` |
| CI | GitHub Actions: full checks on Ubuntu and Windows (Node 24), build and test on Node 22.18.0 and 26 |
| Agent skills | skills.sh 1.7.6, project scope, copied into `.agents/skills` and `.claude/skills`, sources in `skills-lock.json` |

Installed agent skills: abstraction-boundaries, codebase-structure, deslop,
documentation, orwell-clear-writing, ponytail, react-conventions,
typescript-conventions, and unslop. They are copies rather than symlinks, so they
check out correctly where Git does not create symlinks. Oxfmt ignores them.

Repository files:

- `.github/CODEOWNERS` assigns every path to @YLfjuk.
- `.github/pull_request_template.md` covers validation, whether a changeset applies,
  and a public-content check.
- Bug and feature issue forms apply the existing `bug` and `enhancement` labels.
  Blank issues stay enabled, and a contact link points to the security policy.
- `CONTRIBUTING.md` covers requirements, setup, scripts, changesets, and
  pull-request expectations. `SECURITY.md` asks for reports through GitHub
  private vulnerability reporting, with no promised response time.
- `.github/dependabot.yml` checks GitHub Actions and the pnpm workspace weekly,
  with the `dependencies` label. Actions updates are grouped together. Effect
  packages share one group, and other minor and patch updates share another.
  Version updates wait 7 days after release. `vite-plus` is excluded because its
  `vite` and `vitest` overrides in `pnpm-workspace.yaml` must change with it.
- The CI workflow keeps read-only `contents` permission and uses no
  `pull_request_target` trigger. Its check job fails if install, build, or tests
  change a tracked file or leave a file that is not ignored.
- Rulesets, labels, and security settings are configured on GitHub, outside this
  repository. `CONTRIBUTING.md` summarizes the branch policy: changes reach `main`
  only through pull requests, which need passing CI on an up-to-date branch,
  resolved conversations, and a code-owner approval, and merges are squash-only.
  Private vulnerability reporting and the `dependencies` label are enabled.

Node requirement for development and CI: `^22.18.0 || ^24.11.0 || >=26.0.0`, the
range required by Vite+, Vitest 5, and tsdown. `.node-version` selects Node 24.
The library targets ES2022 without Node types, and its own runtime support
policy is still to be decided before the first release.

Layout and conventions:

- `tsconfig.base.json` defines the `@deltafold/dev.src` condition and the strict
  compiler options. The package `vite.config.ts` reads that condition and passes
  it to `pack.exports.devExports`, which matches the shared tsdown template.
  During development, `exports` resolve to `src`; `publishConfig.exports` point
  at `dist`.
- The root `vite.config.ts` holds the lint and format settings that Vite+ applies
  across the workspace. `lint` and `format:check` run as root scripts. Package
  tasks run through Turborepo.
- `vite-plus` is the only test, lint, format, and packaging dependency. No direct
  `vitest`, `vite`, `oxlint`, `oxfmt`, or `tsdown` dependency is declared.
- Each package declares the dependencies that its own files, scripts, and
  configuration use: `vite-plus`, `typescript`, `effect`, `@effect/vitest`,
  `publint`, and `@arethetypeswrong/core`. The root declares only workspace tools:
  `turbo`, `@changesets/cli`, `vite-plus` for root lint and format, and
  `typescript`. Vite+'s bundled tsdown loads publint and attw as optional peers
  of `vite-plus`. pnpm links them only when the package that depends on
  `vite-plus` also declares them; otherwise they resolve through pnpm's hidden
  hoisting.
- The default pnpm catalog in `pnpm-workspace.yaml` holds the shared versions.
  Every devDependency uses `catalog:`. The catalog stays in `pnpm-workspace.yaml`
  because Dependabot does not read catalogs split into other files. The catalog's
  `effect` entry is the range `^4.1.2`, which serves as both the development
  version and the published peer range. Dependabot uses `increase-if-necessary`,
  so updates within that range change only the lockfile.
- `exactOptionalPropertyTypes` is not in the shared base. A package can enable it
  when its API distinguishes a missing property from an explicit `undefined`.
- `allowImportingTsExtensions` allows relative `.ts` imports. Only tsdown emits
  files. `declaration` and `declarationMap` are on, so tsdown writes the `.d.ts.map`
  that the bundled declarations reference. Type checking emits nothing.
- The package publishes `dist` and `src`, so the JavaScript and declaration source
  maps resolve. Published `exports` come from `publishConfig.exports` and do not
  include the development condition.
- Package metadata includes keywords, homepage, bugs, author, and a package
  README.
- `src/index.ts` exports nothing yet. Its targeted lint suppression goes away with
  the first public export.
- No release workflow, npm token, or publish step is configured. The 0.0.0
  placeholder is published manually. `pnpm run changeset` records changes, and
  `pnpm run version` applies them.

### Vite+ trial findings

- Vite+ needs pnpm overrides that alias `vite` to `@voidzero-dev/vite-plus-core`
  and pin `vitest`. The alias version is outside the `vite` peer range of
  Vitest, so `peerDependencyRules.allowedVersions` accepts it.
- Vite+ reads tsdown settings from the `pack` block, so the shared tsdown template
  logic lives in the package `vite.config.ts` rather than in `tsdown.config.ts`.
- Top-level `resolve.conditions` does not reach the Vitest server environment.
  `ssr.resolve.conditions` must also list the development condition, along with
  Vite's default server conditions. Without it, tests resolved `dist`, or failed
  when `dist` was absent.
- tsdown emits declarations with TypeScript 7 but warns that its API is
  experimental. If declaration output regresses, fall back to TypeScript 6 for
  declaration emit.
- Oxlint's Vitest plugin does not recognize `@effect/vitest` test blocks until
  they are listed in `vitest/no-standalone-expect`.
- Oxfmt formats code blocks inside Markdown. `notes/**` is excluded from
  formatting so the design input stays verbatim until it is consolidated.
- `vp test` and `vp lint` print a note that built-in commands take precedence
  over scripts of the same name. The note is harmless.
- `changeset init` in Changesets 3 is interactive, so its default configuration
  was written by hand. Changesets' own formatting is off (`format: false`), so
  there is one formatter configuration, the Vite+ `fmt` block.
- pnpm 12 ships as a native binary. An older global pnpm 10 failed to switch to
  the pinned version on Windows. Upgrading pnpm, or running `npx pnpm@12.18.0`,
  works around it.
- Publishing must go through pnpm, which applies `publishConfig.exports`.
- With `sourcemap: true` and declaration maps off, the bundled `.d.ts` still ends
  with a `sourceMappingURL` comment, but no map is written. Turning on
  `declarationMap` produces the map.
- In CI, pnpm 12 fails the install when a dependency's build script was not
  approved. Locally it only warns. Removing a package can leave its optional
  peers (for example `tsx`, which pulls in `esbuild`) resolved in the lockfile, so
  check the lockfile diff after removing dependencies.

### Changelogs and releases

- Changesets keeps its default formatter, `@changesets/cli/changelog`.
  `pnpm run version` writes `packages/deltafold/CHANGELOG.md`, as a trial
  confirmed. Entries are plain lines with a commit hash.
- GitHub Releases are wanted but not configured. They need a release workflow,
  for example Changesets' GitHub Action, with write permissions and a decision
  about npm publishing.
- Long term, deltafold should generate its own changelog. Changesets' changelog
  plugin interface (`getReleaseLine`, `getDependencyReleaseLine`) formats one
  line per changeset. Changesets itself writes the `## <version>` and
  `### Major/Minor/Patch Changes` headings and prepends the entry to
  `CHANGELOG.md`. A plugin therefore cannot express deltafold sections or
  resolved migration guides. The likely integration sets `"changelog": false`,
  which Changesets supports, and lets a deltafold step render `CHANGELOG.md`
  from the package history. Release metadata from the release plan arrives as
  `Version.withMetadata` annotations, which fits the release-tool adapter
  boundary in the API design. This depends on the phase 3 document layer.

### Deferred: TSDoc examples and generated API docs

`@effect/docgen` is wanted eventually but is not required for the package, so it
is deferred. A trial with version 4.1.2 found the following:

- It copies each `@example` into `docs/examples`, type-checks the copies with the
  project's `tsc` (TypeScript 7 worked), and writes Markdown API docs.
- With `runExamples`, it also runs each example with `tsx`, and failed
  assertions fail the run. Its convention is `node:assert`, which needs
  `@types/node` in the examples' compiler options. Type-check only avoids `tsx`
  and `@types/node` and keeps examples platform-neutral. Vitest still covers
  behavior.
- Requirements: a `homepage` field (now present), `@since` on every export by
  default, Node `>=22.19.0` (one patch above the current minimum), and an
  allowance for its `typescript` peer range (`<7`). It calls the `tsc` binary
  and does not import TypeScript.
- Still open: whether generated docs are committed or only produced in CI.

### Verification

On Windows with Node 24.19.0 and pnpm 12.18.0: `pnpm install` reported no peer
issues, and `pnpm run check` passed format, lint, typecheck, build with publint,
and tests. A second run restored all three Turborepo tasks from cache. Tests
passed with `dist` deleted, which proves that source resolution uses the
development condition. A temporary file with a type error and a floating promise
failed `vp lint`, which proves that type-aware lint and type checking run.
`changeset status` ran with the written configuration.

Setup brief:

- Read applicable repository instructions and tooling templates. Honor the
  selected bare library name deltafold; the composer owns the @deltafold npm scope
  for possible later packages.
- Use a minimal monorepo with packages/deltafold. Do not create empty CLI, codemod,
  or documentation-site packages. TypeScript library, Effect 4 only, MIT.
- Use pnpm for dependency management. Trial Vite+ for development tooling,
  Vitest, Oxlint/Oxfmt, and library packaging. Keep Turborepo responsible for
  workspace task dependencies and caching; do not add overlapping Vite Task
  orchestration. Consult current primary docs and prove the tooling works.
- Use Changesets for publishable-package versioning. Do not publish, add secrets,
  or promise an automated release path that has not been configured.
- Library modeling/planning and document modules must be platform-independent.
  CLI initially targets Node but is deferred. Choose a supported local/CI Node
  version after inspecting current tooling requirements; document the minimum.
- Establish strict TypeScript, package exports/declarations, ignore rules, minimal
  meaningful checks, and CI using the existing templates where applicable. Setup
  may create a minimal package skeleton but must not implement domain features.
- Keep initial bootstrap/setup commits on main if safe in this new repository;
  do not merge an existing PR or overwrite someone else's work. Commit and push
  the setup. Verify install/build/typecheck/lint/format and the available testing
  harness. Record any Vite+ friction and the actual adopted toolchain.
- Complete and verify setup before beginning package implementation.

## Phase 3: prototype and implement the package

Status: in progress on the `feat/core-prototype` branch, started after the user's
explicit approval.

Start a feature branch from the completed setup. Follow the current design notes
and accepted decisions. Keep this plan updated with short acceptance evidence. Do not silently label unresolved
design proposals as settled contracts.

Suggested order:

1. Prove handler typing: ordinary arrays, instance identities, third-party factory
   output, mixed Promise/Effect handlers, service requirements, preconditions, and
   positive/negative compiler cases. Promise callbacks receive resolved services
   and Effect.tryPromise's AbortSignal; native Effect handlers use native
   interruption. Declared rejection cases retain an UnexpectedHandlerError wrapper
   rather than unioning bare unknown into the error channel.
2. Model stable changes/action kinds/instances, branching versions, Package.make,
   and declarative migrations. Versions use changes; migrations use addresses.
   Implement Migration.noop as explicit supported zero-work transitions. No route
   means unsupported, not no work. Do not require direct edges for every pair.
3. Resolve declared routes with provenance, reverse transitions, empty valid plans,
   chained replacements, and shortcuts. Preserve the review's distinction between
   complementary migrations and alternative routes. Test route-policy options
   rather than silently selecting a permanent default. A noninteractive explicit
   route-selection path needs concrete design and useful diagnostics.
4. Prototype declarative action sequences/parallel groups. Migration boundaries
   are sequential barriers. Ordinary rules simplify within sequential branches;
   broader rewrites require explicit structural rules. Never impose an accidental
   order on parallel branches for optimization.
5. Execute with instance handlers, preflight coverage, structured per-occurrence
   results, dry-run preconditions, and stop-on-failure. Stop new actions on any
   branch failure; let started actions settle before final reporting/recovery.
   No automatic sibling interruption. Explicit cancellation/timeouts are separate.
   Preserve undetermined dry-run results behind unapplied dependent work.
6. Implement/readability-test Migration.instruction(action) prose ownership.
   Cancellation omits associated instructions from resolved guides; replacements
   use their own instructions. Historical notes remain intact. Retain explanatory
   provenance. Avoid execution hidden inside nested handlers or prose repeats.
7. Prototype the document layer with mdast and existing serializers. Exercise
   sections, plugin anchors, titles and heading depth, Markdown/HTML escaping, and
   release history versus resolved migration guides. Metadata remains separate
   Version.withMetadata annotations supplied as releases arrays. Package identity
   comes from Package.make, not Changelog.make or metadata.
8. Investigate optional local durability through Effect workflows/SingleRunner
   and SQLite, not a custom workflow runtime. Test crashes and uncertain external
   side effects before claiming safe resume. Retry/rollback remain explicitly
   configured, off by default; do not confuse downgrades with execution undo.

### Phase 3 progress

Each item lists the tests that provide its evidence. "Prototype choice" marks a
behavior picked to make the prototype work; it still needs the user's
confirmation before it becomes a contract.

1. Handler typing: done. `test/handler.test.ts` and the typing cases in
   `test/executor.test.ts` cover payload inference, declared services, the
   reserved `signal` name, error guards and schemas, `UnexpectedHandlerError`, an
   ordinary mixed handler array, a third-party factory
   (`test/__fixtures__/codemod.ts`), missing-binding requirements, `Handler.layer`,
   and `Executor.runPromise` service checks, each with negative cases.
   Findings: TypeScript infers type predicates, so
   `(cause: unknown) => cause instanceof X` is a valid guard. `Schema.is(schema)`
   is generic and breaks inference, so `errors` accepts the schema itself. Guards
   must annotate their parameter type, or the whole `errors` tuple falls back to
   its default. Layer-bound handlers report failures as `BoundHandlerError`,
   because a binding is looked up by identifier and its error type is not visible
   to the executor.
2. Model: done. Change, Action, Version, Migration (`make`, `noop`, `withRevert`),
   Rule, Shortcut, History, and Package. `History.make` does not throw;
   `History.validate` returns aggregated issues in a deterministic order.
   Prototype choices: `Migration.noop(id, { reversible: true })` declares the
   reverse zero-work transition. A non-noop migration with no content is an
   `EmptyMigration` issue. Repeating an action in one migration side is a
   `DuplicateOccurrence` issue that points to `Action.ref`; intentional
   repetition uses separate action instances.
3. Routing: done in `test/history.test.ts`, scenarios 1 to 7. Migrations with
   identical endpoints are one complementary edge and all run in registration
   order. A reverse edge exists only when every migration of the forward group
   has a revert. A route never mixes moves toward ancestors with moves toward
   descendants; explicit cross-branch migrations fit either direction. Route
   identifiers are version identifiers joined by `>`, with shortcut hops written
   as `[id]`. Prototype choice: several candidates fail as `AmbiguousRoute`
   unless the `route` option selects one or an opt-in policy
   (`fewest-actions`, `fewest-migrations`, `lowest-cost`, `prefer-shortcuts`)
   leaves exactly one. `prefer-shortcuts` only drops a route that a candidate
   reproduces with a shortcut; unrelated routes stay ambiguous. Unsupported
   routes report reachable versions, the closest by ancestry distance, and
   blockers.
4. Rewrites and groups: done. Rules match consecutive occurrences on a route's
   sequential spine, across migration boundaries, and inside one parallel
   branch. A parallel pattern is an explicit structural rule. Text-only
   migrations block matching. The resolver explores every rule application and
   reports `RewriteCycle`, `ConflictingRewrites`, or `RewriteLimitExceeded`
   (10 000 states or 256 chained applications); equal outcomes reached by
   different rules are accepted. Replacement occurrence identifiers name the
   rule and the replaced occurrences. Prototype choice: a replacement that
   spans migrations belongs to the step of its first replaced occurrence.
5. Execution: done in `test/executor.test.ts`. Coverage is checked before any
   precondition or body runs. Failures stop admission while started actions
   settle. Explicit cancellation interrupts in-flight actions; a timeout
   interrupts only the timed-out action. Reports state whether an interrupted
   Promise settled within `settleTimeout` (5 seconds by default, a prototype
   choice). Dry runs evaluate preconditions only when no earlier action in the
   same dependency chain could have changed state; independent parallel
   branches are evaluated against the state before the group.
6. Prose ownership: done. Resolved guides drop cancelled instruction blocks,
   render replacements at their first replaced occurrence with their own
   instruction or description, keep shared prose, keep text-only migrations, and
   omit steps whose actions were all removed. `changelog.upgrade(plan, { explain:
   true })` lists the omissions and responsible rules. `test/changelog.test.ts`
   renders both the guide and the history that keeps the original changes.
7. Document layer: done in `test/changelog.test.ts`, scenarios 12 to 15. The
   `deltafold/changelog` entry holds the Document semantic layer and
   `Changelog.make`. `deltafold/markdown` and `deltafold/html` lower to mdast and
   reuse mdast-util-to-markdown 2.2.0, mdast-util-to-hast 13.2.1, and
   hast-util-to-html 9.0.5, which handle escaping in both formats. mdast is
   adequate for headings, paragraphs, lists, links, inline code, and code blocks.
   Prototype choices: releases are listed newest first by semver when every
   identifier parses; `changelog.change` titles drafts "Unreleased"; a standalone
   release has no package wrapper; release-scoped plugins run once per included
   release and history-scoped plugins once per document; missing, duplicate, and
   unrelated release metadata throw `ReleaseMetadataError`, and the `versions`
   option limits a history. The serializer dependencies are pinned exactly; their
   published ranges are decided before release.
8. Durability investigation: done as a scratch probe outside the repository,
   with effect 4.1.2, @effect/sql-sqlite-node 4.1.2 (built on `node:sqlite`), and
   @effect/platform-node 4.1.2 on Node 24. A workflow ran three activities on
   ClusterWorkflowEngine and SingleRunner with SQL runner storage in a SQLite
   file. Each activity appended its side effect to a log, and the first run exited
   after the second activity's side effect but before its result was saved.
   - Resume replayed the first activity from storage without running it, ran the
     second activity again, and finished. Recorded completion is reused, but the
     interrupted step repeats: no exactly-once external writes.
   - Recording a "started" marker activity before each body lets resume detect the
     uncertain step and fail instead of repeating it.
   - Resuming with a renamed activity ran the new definition without any error.
     The engine does not detect definition changes, so deltafold would have to
     record a plan fingerprint and compare it on resume.
   - Activities retry interruptions up to 10 times by default.
     `interruptRetryPolicy: Schedule.recurs(0)` turns that off, which deltafold
     needs because retries are opt-in.
   - The workflow and cluster modules are marked unstable, and the SQLite client
     and crypto digest layer are Node-specific. Any durable executor belongs in
     an optional Node entry point or package, not in the core.
   Not built: a durable executor. A design would run each occurrence as a
   guarded activity, store the plan fingerprint and route as the first activity,
   fail on uncertain steps with an explicit recovery choice, and keep
   stop-on-failure.

Open questions for the user, with the current prototype behavior:

- Route selection default: ambiguity fails, including when a newly added
  shortcut introduces a second candidate. Should `prefer-shortcuts` become the
  default?
- Repeated interpolation: currently a validation error. Alternative: it
  declares a second occurrence with a positional identifier.
- Static coverage uses the history's whole action union, so `runPromise` on a
  resolved plan needs handlers for every action in the history.
  `Plan.withRuntimeCoverage` opts out. Is that the right default for Promise
  users?
- Cross-migration replacement placement (first replaced step) and the
  `settleTimeout` default.
- Whether to build the optional durable executor described in step 8, and
  where it lives.

Acceptance evidence should cover the scenarios in api-design.md and reviewer
findings. In particular, establish stable occurrence identifiers and actionable
error/report contracts where necessary. Type/schema options, repeated occurrences,
route policy, and exact recovery syntax may need focused user decisions. Continue
independent authorized work while design decisions are pending.

Do not implement the deferred CLI, select a mandatory codemod engine, introduce a
new Migrator layer, provision a hosted workflow provider, or publish npm packages
as part of the core prototype without further direction. Handlers are the public
execution integration boundary; helpers in any package can return them.

Commit useful checkpoints, run checks appropriate to each meaningful change, and
push a reviewable branch. Create a draft PR when the prototype is reviewable; link
it in the project tracking context. Do not merge without instruction. Report
what is actually implemented, tested, incomplete, or awaiting a design decision.

Completion criteria for notes: once implementation is complete, clean up the notes.
Much of the proposal, review, and work-tracking material will be obsolete by then.
Keep the specification and review notes as implementation input until then; do not
clean them up early.

- Consolidate the useful content into maintained documentation: functional
  requirements, non-functional requirements, API and usage documentation, and
  short design or decision notes where needed.
- Remove superseded proposals and redundant reviewer and work-tracking history
  instead of keeping them as permanent documentation.
- Describe implemented, verified behavior. Label actual limitations, and keep
  unresolved requirements stated honestly.
- Keep one source of truth for each topic, and do not duplicate the API reference
  across notes.
- Bring the maintained documentation under `vp fmt` by removing the `notes/**`
  formatter exclusion, or by narrowing it to any remaining verbatim input.
