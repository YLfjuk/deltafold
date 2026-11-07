# deltafold requirements

These are the project's functional and non-functional requirements. Each one has
a status:

- **Implemented**: behavior exists and the named tests cover it.
- **Prototype**: behavior exists, but it is a provisional choice listed in
  [decisions](decisions.md) that needs confirmation before 1.0.
- **Not implemented**: an agreed requirement with no implementation yet.

Usage is documented in the [package README](../packages/deltafold/README.md).
Test files are in `packages/deltafold/test`.

## Scope

deltafold models version history and resolves migration instructions between
versions, including an explicit `0.0.0` baseline. Authors declare changes,
actions, migrations, rules, and shortcuts. Consumers receive an ordered plan of
the instructions that remain after optimization. The same declarations produce
historical release notes and resolved upgrade or downgrade guides.

Three relationships stay separate: release ancestry (which release a version
descends from), migration routes (supported transitions between exact versions),
and execution bindings (handlers for action instances). Optimization never erases
release history.

## Functional requirements

### Declarations

| Requirement                                                                                                                                                                                                                                                                     | Status                                         | Evidence                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------- |
| A change has a stable identifier, kind (`added`, `changed`, `removed`, `fixed`), breaking flag, description, and optional `reverts` and `backportOf` relationships. Editing prose keeps identity. `reverts` is historical only.                                                 | Implemented                                    | `history.test.ts`, `changelog.test.ts` |
| Conflicting definitions of one change or action identifier are errors; referencing one definition from several places is valid.                                                                                                                                                 | Implemented                                    | `history.test.ts` validation           |
| An action kind defines a payload type and description. Instances have stable identifiers; one kind has many independently handled instances.                                                                                                                                    | Implemented                                    | `executor.test.ts`                     |
| A version references its predecessor. Several versions can share a predecessor; declaration order and semver do not change ancestry. Ancestry is acyclic.                                                                                                                       | Implemented                                    | `history.test.ts` scenario 2           |
| A migration names exact endpoints, the changes it addresses, and tagged-template content. Action interpolations and instruction blocks declare occurrences; `Action.ref` only mentions an action; scalars add text; other values are rejected by types and at declaration time. | Implemented                                    | `history.test.ts`                      |
| `Migration.instruction(action)` associates prose with exactly one occurrence.                                                                                                                                                                                                   | Implemented                                    | `history.test.ts`, `changelog.test.ts` |
| `Migration.noop` declares a directed zero-work transition, optionally reversible.                                                                                                                                                                                               | Implemented; reversibility syntax is Prototype | `history.test.ts` scenarios 1 and 7    |
| `Migration.withRevert` adds a reverse side under the same identifier. No reverse declaration means no reverse edge.                                                                                                                                                             | Implemented                                    | `history.test.ts` scenario 7           |
| Migrations register independently of versions. Registering a migration twice, including with its `withRevert` result, is an error.                                                                                                                                              | Implemented                                    | `history.test.ts` validation           |
| Repeating an action in one migration side is a validation error that points to `Action.ref`.                                                                                                                                                                                    | Prototype                                      | `history.test.ts` validation           |
| `Package.make` owns the modeled package's name and history, and nothing else.                                                                                                                                                                                                   | Implemented                                    | `changelog.test.ts`                    |
| `History.validate` reports all independent declaration issues in a deterministic order. `History.make` does not throw.                                                                                                                                                          | Implemented                                    | `history.test.ts`                      |
| A migration `requires` field for explicit dependencies between migrations.                                                                                                                                                                                                      | Not implemented                                |                                        |
| Runtime payload schemas, imported-history validation, and serialized plans.                                                                                                                                                                                                     | Not implemented                                |                                        |

### Planning

| Requirement                                                                                                                                                                         | Status                                                 | Evidence                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `History.resolve` returns a `Result`: a plan with endpoints, route, ordered steps, addressed changes, and explanations, or a tagged error. Planning needs no handlers.              | Implemented                                            | `history.test.ts`                                    |
| An empty plan is valid. A missing route is `UnsupportedRoute`, never "no work".                                                                                                     | Implemented                                            | `history.test.ts` scenario 1                         |
| A backport migrates only through declared support; sharing an ancestor does not authorize a downgrade-and-upgrade detour.                                                           | Implemented                                            | `history.test.ts` scenario 2                         |
| Migrations with identical endpoints are complementary and all run. Alternative routes are different version paths or shortcuts.                                                     | Implemented                                            | `history.test.ts` scenario 3                         |
| Ambiguous routes fail with identifiable candidates. A `route` option selects one; opt-in policies choose by action count, migration count, declared cost, or shortcut substitution. | Prototype                                              | `history.test.ts` scenarios 3 and 6                  |
| Shortcuts must replace a consecutive registered route between their endpoints, and their migrations must form a route between the same endpoints.                                   | Implemented                                            | `history.test.ts` scenario 6                         |
| Downgrade failures report reachable versions, the closest by ancestry distance (ties included), and blockers. Nothing falls back without a consumer choice.                         | Implemented                                            | `history.test.ts` scenario 7                         |
| `History.upgrades` and `History.downgrades` list reachable destinations with candidate route identifiers.                                                                           | Implemented                                            | `history.test.ts` scenario 7                         |
| Rules replace consecutive occurrences, including across migration boundaries. They never match around an intervening action, a text-only migration, or across parallel branches.    | Implemented                                            | `history.test.ts` scenarios 4 and 5, parallel groups |
| Rules chain through replacements, preserve ordered provenance, and report cycles, conflicting outcomes, and runaway growth without depending on registration order.                 | Implemented                                            | `history.test.ts` scenario 5                         |
| Broader rewrites of parallel groups need explicit structural rules.                                                                                                                 | Implemented                                            | `history.test.ts` parallel groups                    |
| A failed downgrade distinguishes migration support from execution undo.                                                                                                             | Implemented: reverse migrations are routes, never undo | `history.test.ts` scenario 7                         |

### Execution

| Requirement                                                                                                                                                                                                                                                       | Status                                                       | Evidence                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `Handler.promise` adapts Promise callbacks through `Effect.tryPromise`, passes its `AbortSignal` and declared services, and reserves `signal`. `Handler.effect` keeps native errors, services, and interruption.                                                  | Implemented                                                  | `handler.test.ts`                                 |
| Declared error guards or schemas keep rejection types; other rejections become `UnexpectedHandlerError` with action identity. The error channel never collapses to `unknown`.                                                                                     | Implemented                                                  | `handler.test.ts`, `executor.test.ts`             |
| Mixed handler arrays and third-party factories infer payloads, errors, and service requirements; statically known missing handlers appear in requirements; `Handler.layer` provides bindings.                                                                     | Implemented                                                  | `executor.test.ts` typing                         |
| Coverage is checked before any precondition or body runs, including duplicate and mismatched handlers. Missing replacement handlers name the rule and replaced occurrences.                                                                                       | Implemented                                                  | `executor.test.ts`                                |
| Preconditions: absent or `true` runs; `false` skips with a reason; a failure fails.                                                                                                                                                                               | Implemented                                                  | `executor.test.ts`                                |
| Migration steps are sequential barriers. Explicit parallel groups run branches concurrently within a step.                                                                                                                                                        | Implemented                                                  | `executor.test.ts`                                |
| On failure, no new action starts, running actions settle without interruption, and the error carries a report of completed, skipped, failed (with phase), and unattempted occurrences. The Promise executor rejects with the same report.                         | Implemented                                                  | `executor.test.ts`                                |
| Explicit cancellation and per-action timeouts interrupt work, abort Promise signals, and report whether interrupted Promises settled. A sibling failure never interrupts.                                                                                         | Implemented; `settleTimeout` default is Prototype            | `executor.test.ts`                                |
| Dry runs never run bodies. Checks behind potentially mutating earlier work report `Undetermined`; independent branches evaluate against the state before the group; failed checks stay failures.                                                                  | Implemented                                                  | `executor.test.ts` dry runs                       |
| Reports state that no progress is persisted.                                                                                                                                                                                                                      | Implemented                                                  | `executor.test.ts`                                |
| Integration modules, official or third-party, export handler factories built on `Handler.promise` or `Handler.effect`. Executors need no engine registry and never inspect handler internals. The core assumes no language, file type, parser, or codemod engine. | Implemented                                                  | `executor.test.ts` with `__fixtures__/codemod.ts` |
| An engine's own preview mode stays distinct from deltafold dry runs, which never call handler bodies.                                                                                                                                                             | Not implemented: no preview capability exists                |                                                   |
| Opt-in retry and rollback, configured explicitly, that keep the original failure and partial report. Downgrades are never automatic undo.                                                                                                                         | Not implemented                                              |                                                   |
| A logging and reporting capability for handlers and adapters, filtered by log level.                                                                                                                                                                              | Not implemented                                              |                                                   |
| Optional local durability and resume, built on Effect workflows rather than a new runtime.                                                                                                                                                                        | Not implemented; investigated, see [decisions](decisions.md) |                                                   |

### Documents

| Requirement                                                                                                                                                                                                                                            | Status                                      | Evidence            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------- |
| `Changelog.make` configures sections (first match wins, empty sections disappear, unmatched changes go to "Other changes" unless disabled) and plugins. It has no package name option.                                                                 | Implemented                                 | `changelog.test.ts` |
| `changelog.change`, `release`, `history`, and `upgrade` return document values; `Markdown.render` and `Html.render` produce strings.                                                                                                                   | Implemented                                 | `changelog.test.ts` |
| A history document uses the package name as its outermost title and keeps reverted changes. A resolved guide omits cancelled instructions, uses replacement instructions or descriptions, keeps shared and text-only prose, and can explain omissions. | Implemented                                 | `changelog.test.ts` |
| Release metadata stays outside history as `Version.withMetadata` annotations passed as arrays. Duplicate, missing, and unrelated annotations are errors.                                                                                               | Implemented                                 | `changelog.test.ts` |
| Plugins run once per scope at named insertion points, in configuration order, without recursion. Section identifiers are unique within their release.                                                                                                  | Implemented                                 | `changelog.test.ts` |
| Heading levels follow nesting; explicit levels are absolute; unsupported levels are errors.                                                                                                                                                            | Implemented                                 | `changelog.test.ts` |
| Rendering reuses existing serializers and escapes content in Markdown and HTML.                                                                                                                                                                        | Implemented                                 | `changelog.test.ts` |
| History display order, branch labels, and an optional metadata schema.                                                                                                                                                                                 | Prototype for order; others Not implemented |                     |

### Command-line interface

All CLI requirements are Not implemented. The CLI is deferred until the
library has settled.

- Provide a ready-made CLI or a reusable builder that composers can expose from
  their own package, sharing one command implementation. Package identity comes
  from `Package.make`.
- Commands cover changelog generation, migration planning and application, dry
  runs, and listing upgrade and downgrade destinations. Shared options include
  source and target versions, entry point, output format and destination, log
  level, and noninteractive reporting. Unsupported or ambiguous routes fail
  instead of guessing; recovery flags map to the library's recovery policy.
- Documents and structured results go to stdout unless an output destination is
  chosen. Diagnostics and progress go to stderr. Log level filters deltafold,
  Effect, and adapter logs, but never suppresses results or a nonzero exit
  status. Machine-readable output stays parseable. The CLI must not patch the
  global console. A subprocess adapter that promises log-level compliance must
  capture, classify, and route tool output, including failures reported without
  a rejected Promise.
- Loading an entry module must not start migration bodies. A dry-run flag is not
  an import sandbox.

## Non-functional requirements

| Requirement                                                                                                                                                                                                     | Status                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| TypeScript library on Effect 4 only, MIT licensed, ESM.                                                                                                                                                         | Implemented                                                                     |
| Modeling, planning, execution, and document modules are platform independent. Node.js filesystem and process APIs belong at explicit runtime boundaries. The planner never inspects or modifies consumer files. | Implemented                                                                     |
| Planning and rendering are deterministic: issues, candidates, explanations, and reports have stable orders, and outcomes never depend on rule registration order.                                               | Implemented                                                                     |
| Resolution terminates: at most 100 candidate routes, and at most 10 000 explored states or 256 chained rule applications per optimization.                                                                      | Implemented                                                                     |
| Occurrence, route, and error identifiers are stable and machine readable; errors carry `_tag` discriminants and structured fields.                                                                              | Implemented. A versioned JSON envelope and plan fingerprint are Not implemented |
| No hidden retries, rollbacks, or interruption of sibling work. No claim of exactly-once external effects.                                                                                                       | Implemented                                                                     |
| Serializer dependencies live in the `deltafold/markdown` and `deltafold/html` entry points only.                                                                                                                | Implemented                                                                     |
| Minimum supported runtime versions for the published library.                                                                                                                                                   | Not decided                                                                     |
