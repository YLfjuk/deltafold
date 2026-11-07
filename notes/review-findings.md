# deltafold UX, DX, and AX review findings

Reviewed: 2026-11-07. Subject: [API design](api-design.md), before implementation.
AX means agent and automation experience. Proposed responses below are not
accepted specification changes. No reviewer edited the specification.

## Review perspectives

Independent reviews covered developer experience, human user experience, and
agent/automation experience. Findings below are consolidated by topic.

## Overall assessment

All reviewers supported the separation between ancestry, migration routes, and
execution. They also endorsed absent-route versus empty-plan distinctions,
Promise/Effect interoperability, explicit skips versus failures, metadata-free
history, and separate diagnostic/result streams.

The strongest concerns are underspecified contracts, not evidence that the overall
API needs replacement. Some findings overlap with deliberately open prototype
questions. Do not count speculative type-inference risks as proven compiler bugs.

## Highest-priority findings

### R1: define a conservative dry-run contract

Raised by DX, UX, and AX. Relevant design sections: Executors, reports, dry runs,
and recovery; CLI requirement and proposed entry point.

If action A would create a key and B's condition checks for that key, a dry run
checking the current filesystem can falsely predict that B will skip. The spec
requires undetermined results but has no way to identify dependent checks.

Proposed response: establish a conservative default and prototype explicit
independence/dependency annotations. A check after a potentially mutating step must
not imply certainty without evidence. State whether consumer precondition code
was evaluated. Treat the final dry-run report as command output, not a log that
vanishes at warn/error log levels. Pure planning must remain a distinct operation
that invokes no preconditions or action bodies.

### R2: define what happens to prose when actions disappear

Raised by UX, with related occurrence concerns from DX. Relevant design sections:
Migrations and tagged instructions; Replacement rules and shortcuts; Changelog
configuration and sections.

Cancelling an interpolation can leave text such as "Update your configuration"
or "The value remains in milliseconds" without the instruction it describes.
Automatically deleting adjacent prose can also remove useful information.

Proposed response: prototype an explicit prose/action association or a visible
omission policy. Do not silently assume every sentence belongs to the next action.
Historical release notes must remain intact whichever guide policy is chosen.

Accepted follow-up: optional Migration.instruction(action) tagged blocks declare
one action occurrence and explicitly associate its prose. Cancellation omits the
block; replacement uses replacement-specific instructions or the new action's
description. Shared migration prose remains while actions survive; if optimization
removes every action, omit that migration from the normal resolved guide.
Historical content and explanation provenance remain intact. Exact replacement
instruction and grouped-block syntax still need prototype validation.

### R3: ambiguity needs an actionable route-selection input

Raised by UX and AX. Relevant design sections: Replacement rules and shortcuts;
Planning, reversal, and reachability; CLI requirement and proposed entry point.

The spec requires consumers to choose rather than silently fall back, but resolve
currently shows only from/to inputs. An agent or CI job cannot answer an ambiguity
unless candidate routes have identifiers it can submit back.

Proposed response: expose identifiable candidate routes and an explicit selection
input in both API and CLI. Report the exact corrective invocation. Keep automatic
route policy open for UX/DX trials, including what happens when a newly added
shortcut introduces another candidate. Do not require direct migrations for every
version pair: composed declared routes remain valid.

### R4: make partial execution and rerun risk explicit

Raised by UX and AX. Relevant design section: Executors, reports, dry runs, and
recovery.

When step four fails after three successes, rerunning the original command may
repeat those successes. The current report does not define persistence or resume
semantics, and an external CI system may retry independently of deltafold's policy.

Proposed response: reports must identify preflight versus body failures and whether
any action bodies started. Preserve a machine-readable partial report on failure
and explicitly state that no progress is persisted unless configured. Do not infer
safe retry from a failure code alone. A body may have partially changed external
state. A field claiming exact effects must not exceed what handlers can establish.
Resume storage and recovery policy can remain prototype decisions.

### R5: prove Effect requirements survive ordinary handler collections

Raised by DX. Relevant design sections: Executors, reports, dry runs, and recovery;
Handler interoperability and optional migration engines.

The examples use normal arrays and promise third-party error/service inference.
Poor generic signatures could erase requirements or demand surprising tuple casts.

Proposed response: positive and negative compiler examples using ordinary arrays,
third-party factories, mixed Promise/Effect handlers, and missing services. Add a
collection helper only if it is actually necessary. This is a prototype risk, not
a demonstrated flaw in an implementation.

## Further actionable findings

### R6: replacement actions need discoverable handler coverage

Raised by DX and UX. A rule-produced A-to-C action needs its own instance handler;
handlers for A-to-B and B-to-C do not implement it. Missing coverage errors should
show the replacement description, producing rule, and original occurrences.
Demonstrate a reusable module factory to reduce repeated bindings. Preserve the
agreed ability for either composers or consumers to supply handlers; requiring
every declarative rule itself to ship execution code would break that separation.

### R7: validate identities and repeated occurrences explicitly

Raised by DX and UX. Registering both a migration and its withRevert result must
not accidentally double execution. Repeating an action interpolation in prose can
also create a second occurrence.

Proposed response: specify migration-ID behavior under withRevert and detect
duplicate/conflicting registrations. Distinguish intentional repeated action
occurrences from duplicate migration definitions. Show occurrence locations/counts
in plans or validation diagnostics. The reviewer called the registration issue a
contradiction; the narrower interpretation is a missing validation contract.

### R8: establish stable machine-facing report identity

Raised by AX. Agents need occurrence IDs, not only action-instance IDs, to compare
dry-run and execution events. They also need stable error tags, optional skip
codes, deterministic ordering, and versioned JSON result/error envelopes.

An optional plan fingerprint plus an expected-plan input could detect drift
between inspection and execution. This is a candidate capability to scope in a
prototype, not a reason to require executable serialized plans. A plan digest
does not prove unchanged handler code or external state.

### R9: make inspection and validation useful without execution

Raised by UX and AX. Add a clear plan/inspect path that uses only declarations and
no preconditions. Entry modules can still execute code during import; loading a
package separately from optional handler modules reduces unnecessary imports but
does not sandbox arbitrary module initialization.

Consider a validation command that aggregates independent errors deterministically:
ancestry, duplicate IDs, handler coverage for selected plans, annotation matching,
and plugin sections. Unsupported version pairs are not automatically errors; route
coverage validation needs declared support expectations.

### R10: demonstrate complete authoring and readable outputs

Raised by DX and UX. Add a copyable Promise-only example spanning resolve success,
resolve failure, execution, and partial-report access. Add a maintained-branch
example with an explicit empty transition and registered reverse migration.

Prototype history ordering and visible branch labels, an unreleased/draft
presentation, and useful missing-metadata diagnostics without silently weakening
the agreed metadata contract. Clarify package-aware planning and identity in
reports. CLI statuses should use text, honor disabled color, and remain linear in
noninteractive environments. TypeScript entry loading is an early onboarding
decision, not an obscure implementation detail.

## Recommended discussion order

1. R1 dry-run certainty and R2 prose/action association.
2. R3 explicit route choice and R7 identity/occurrence validation.
3. R4 failure report and rerun contract, then R8 machine-readable identities.
4. Prove R5 and R6 through the handler prototype.
5. Test R9 and R10 with end-to-end maintainer, consumer, and agent walkthroughs.

Route preference, closest-downgrade distance, retry/rollback configuration, mdast,
and exact CLI flag/exit-code spelling remain deliberately open. No automatic
acceptance of reviewer recommendations is implied.

## Follow-up direction: execution dependencies

The composer selected migration boundaries as conservative sequential dependency
barriers. Within a migration, use serial defaults and opt-in explicit independent
branches, including sequential groups running alongside other independent work.
Effect supplies scheduling semantics; declarative group syntax remains to be
prototyped. This addresses R1's missing source of dependency information without
introspecting callback code. Preserve unknown predictions behind unapplied steps.
Ordinary rules simplify inside sequential branches; broader replacements require
explicit structural rules. On concurrent failure, stop new actions and let
in-flight actions settle before reporting or optional recovery. A sibling failure
does not itself request cancellation. Expose AbortSignal to handler callbacks for
explicit cancellation/timeouts and cooperative integration with Promise APIs.
Effect/signal bridging and recovery ordering still need prototype validation.
Prefer visible action groups over hidden handler-to-handler orchestration so
coverage and dry-run reporting remain inspectable.

## Setup choices collected alongside review

- Visibility: public from the start.
- License: MIT.
- Package manager: pnpm provisionally; trial Vite+ for the development toolchain
  while retaining Turborepo for workspace orchestration.
- Supported runtimes: Node.js CLI initially; platform-independent library modules.
  Exact minimum runtime versions remain open.
- CLI implementation is deferred until the prototypes and main package logic have
  been tested. Separate `@deltafold/cli` versus `deltafold/cli` and
  `deltafold/cli/node` exports remains open.
- The composer has registered the `@deltafold` npm scope.

No GitHub repository has been created by this review step.
