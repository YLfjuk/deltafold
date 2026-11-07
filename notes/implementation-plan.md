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

Status: pending.

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

Status: pending; depends on phase 2.

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
