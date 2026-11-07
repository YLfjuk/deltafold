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

Status: setup complete on branch `setup/workspace-tooling`, in review as a pull
request. It is not merged.

Approval gate: the user reviews the setup before package implementation begins.
Phase 3 starts only after the user explicitly approves the setup.

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
- No release workflow, npm token, or publish step is configured. `pnpm run
  changeset` records changes, and `pnpm run version` applies them.

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

Status: pending; waiting for the user to approve the phase 2 setup.

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
