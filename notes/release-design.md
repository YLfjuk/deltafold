# Release design

Status: accepted direction, with a private prototype in `packages/release`.
Examples are API sketches; the prototype's exact interfaces may change. Open
questions and prototype findings are listed at the end.

## Ownership

`@deltafold/release` owns release-group configuration, release planning, local
apply, optional version strategies, dependents policies, release authoring
conveniences, and its release CLI. Composition with `@deltafold/cli` is later
work. Core owns headless Change and Version/migration models, not bump policy,
pending discovery, source writing, or publication.

Migrations are authored separately against assigned versions. Release tooling
does not discover or rewrite their relationships. A future NextVersion helper is
optional and not a prerequisite.

## Change contracts

Core supports `Change.make(id)` without metadata,
`Change.make(id, metadata)` with inferred metadata, and
`Change.define<Metadata>()` returning a reusable typed factory with `make`.
Identity, description, relationships, and provenance remain core concerns.
Fields called kind, breaking, or bump have no built-in core semantics.

Optional `ReleaseChange` builds on Change and requires bump metadata.
`ReleaseChange.define<ExtraMetadata>()` adds consumer fields while retaining
that contract. Consumers may instead supply any compatible custom Change
factory. The configured factory establishes the default metadata type for
policies and extensions; it is not mandatory to use ReleaseChange.

Final bump metadata vocabulary is major, minor, patch. Prerelease stage is a
plan-level choice, not a property of individual changes.

## Group configuration and planning

```ts
const release = Release.make("widgets", {
	packages: [
		{ package: widgets },
		{ package: widgetsReact },
		{ package: tools, version: toolsVersionStrategy },
	],
	change: ProjectChange,
	previous: Release.Source.packageJson(),
	version: VersionStrategy.semver({
		baseline: "highest",
		bump: (change) => change.metadata.bump,
	}),
	dependents: DependentsPolicy.propose(),
	replacements: [
		{
			files: ["packages/widgets/src/**/*.ts", "docs/**/*.md"],
			exclude: ["**/generated/**"],
			match: "@next",
			versionOf: widgets,
		},
	],
});

const plan = release.plan({
	packages: [
		{ package: widgets, changes: widgetChanges },
		{ package: widgetsReact, changes: reactChanges },
	],
	pre: { tag: "beta", continue: true },
});
```

Release.make requires a stable group ID. Membership is bounded to registered
packages; plan input cannot silently introduce another package. Package/change
associations belong to release configuration/input, not to core Change or the
pending declaration. A shared change can be included for several packages.

Release.plan remains the one-off equivalent of a configured planner. Root
version settings supply a shared calculation; per-package overrides supply
independent versions or strategies. Only inheriting packages influence the
shared calculation. Literal target versions are supported at either level.

Per-run options override configured defaults at the same level; per-package
options override root settings. Arrays replace arrays rather than concatenate.
Omitted defaults inherit; an empty list explicitly disables that list. Pre is
an exception: it exists only on plan input and never on Release.make.

## Version strategies and baselines

VersionStrategy.semver is optional. Consumers can supply their own synchronous
strategy over their own metadata. External data is resolved before synchronous
policy evaluation. Both built-in and custom strategies initially produce valid
SemVer output; other ecosystems are deferred and may justify a breaking change.

The baseline policy supports highest (default), require-matching, and an explicit
baseline version. A baseline is used for calculation, not assigned as ancestry.
An explicit target bypasses calculation. Exact syntax for the richer baseline
policy remains a prototype detail.

Baseline policy also controls alignment. Align unchanged participants to an
advancing shared version by default; allow unchanged-package drift explicitly.
Accept drift in major/minor/patch numbers, prerelease counters and identifiers,
and mixed stable/prerelease versions. Highest selects one complete version by
SemVer precedence, never components from different versions. Each generated
version retains its package's actual previous-version reference. Reject targets
that downgrade a participant.

## Prerelease behavior

Omitting pre on a plan means stable output. A prerelease requires the full object
`pre: { tag: string, continue: boolean }`; both fields are required. No boolean
or string shortcuts, inherited pre default, or configured-default-tag behavior.

continue false starts a prerelease line. continue true continues its target
unless accumulated bump intent requires a higher-level target. A line tracks
its stable baseline and strongest accumulated major/minor/patch intent. New
patch changes do not lower a line already preparing a major release.

Example from stable 1.5.2: patch starts 1.5.3-beta.0; another patch continues at
1.5.3-beta.1; a major elevates to 2.0.0-beta.0; another patch continues at
2.0.0-beta.1. Reset the counter to zero when tag or numeric target changes;
otherwise increment it. No-downgrade checks still apply to tag transitions.
Continue without an existing prerelease line is a planning error.

The plan's configured tag determines the output identifier even with mixed
baselines. A shared calculation uses a consistent stage choice. Exact handling
of independent line contexts within one group must be exercised in prototypes.
Prerelease identifiers are distinct from publishing distribution tags.

Superseded: premajor/preminor/prepatch/prerelease as separate change bump values;
per-change pre intent; mixed-intention mode; pre true, pre "continue", and
inherited default tags. Use magnitude metadata plus the plan-level object.

## Dependency policy

DependentsPolicy.propose proposes required dependency edits and releases in the
plan. DependentsPolicy.explicit reports missing selections. Custom synchronous
policies are supported. Distinguish manifest edits from published releases,
especially for private packages and different dependency types. Resolve
propagation before review; apply never discovers new participants.

A dependent outside the group produces a cross-group requirement; it does not
silently expand group membership. Cross-group orchestration is not initial scope.

## Files, pending inputs, and replacements

Global and package-local pending locations are authoring conveniences; folder
layout is not mandatory. Initial apply consumes all pending changes within the
configured release scope together. Partial consumption of shared inputs is
deferred. Do not introduce a per-package pending-consumption ledger initially.

Generate one file per version, with configurable directory and stable export
name. Custom output layouts are deferred. Copy selected declarations into each
applicable version file, preserving stable change IDs. Shared copies represent
release membership of the same logical change, not newly invented identities.

Preserve authored TypeScript expressions and required imports without evaluating
metadata to reconstruct source. Adjust relative imports while retaining meaning.
Report unsupported relocation instead of silently evaluating or changing code.
This has handwritten-source semantics: imported helpers can evolve, and deep
freezing their behavior is not promised. Planning may still load declarations
so policies can inspect their metadata. Avoid requiring a JSON metadata codec.

Root-level replacement rules select files by globs/exclusions, literal tokens,
and an explicit package whose resolved version supplies the replacement. Targets
can include private packages, docs, examples, and files outside group membership.
Include edits in the plan. Zero files/token matches are allowed and reported.
Reject conflicting replacements of the same occurrence. Broad regex or semantic
symbol replacement is not required for the initial literal-token implementation.

## Flow and failure behavior

Resolve sources into explicit inputs, validate membership and previous versions,
calculate policy and dependency effects, prepare source/file edits, review, check
freshness, then apply. Plan calculation does not write. Source loading may do I/O;
do not imply policy callbacks or pure planning hide arbitrary network reads.

Explicit previous versions and manifest-backed sources are supported. The source
is separate from version policy. A local manifest is not proof of remote registry
freshness. Do not invent ancestry for an unknown resolved previous version.

The plan reports versions, selected changes, generated records, dependency edits,
replacement locations/zero matches, pending cleanup, and explanations. Stale
pending files, manifests, or replacement targets cause refusal and replanning;
never recalculate an approved plan silently.

Apply modifies local files only. Preserve release records before consuming
pending inputs. On failure, attempt to restore files changed by this operation
and report restoration failures. No crash-safe atomicity claim. Prototype safe
reruns and interruption boundaries before prescribing persistence machinery.

Git commits, tags, publishing, and publication metadata are separate explicit
steps. Core migration execution/rollback behavior is not release apply policy.

## Open prototype questions

- Stable promotion contents: compare automatic collection from prerelease history
  with explicit selection. Include prerelease-only fixes, shared changes and
  repeated IDs. Neither behavior is accepted as default.
- Source relocation: supported declaration/dependency patterns, factory import
  discovery and explicit reference fallback, collisions and diagnostics.
- Exact VersionStrategy/DependentsPolicy callback contracts, rich baseline shape,
  coherent prerelease-line bookkeeping with drifting/independent packages, and
  handling no-change plans. Do not infer new product policy from syntax examples.

## Deferred authoring tooling

Custom .change.delta/.version.delta files with filename-derived IDs and a
TypeScript content mapper are wanted, not initial implementation scope. Preserve
the same underlying models and optional ordinary TypeScript path. See
[wanted features](wanted-features.md). Evaluate the TypeScript 7.1 compiler API
for generation and in-memory validation without imposing it on core.

## Prototype findings

The prototype in `packages/release` is private and unpublished. It builds on
headless `Change` from the core.

These contracts worked as accepted:

- Bounded groups with a required ID. Per-package settings leave the shared
  calculation, plan options replace configured ones, and literal targets work at
  both levels. Every generated version keeps its package's own `previous`.
- The configured factory's metadata type reaches strategies, and changes from
  another factory are type errors. Strategies are synchronous in their type and
  at run time.
- Highest, require-matching, and explicit baselines. Unchanged members align by
  default and drift when the strategy allows it. Downgrades fail.
- The prerelease sequence above, from recorded line state. Continuing without a
  line, a tag change that lowers precedence, and stable promotion fail with
  diagnostics.
- Pending modules copied into one generated module per version without
  evaluation. Relative imports are re-pointed and a shared change is copied into
  each package's module with the same ID.
- Literal replacements with globs, exclusions, zero-match reports, and overlap
  conflicts. Apply refuses when any file read during preparation, or the set of
  matched files, changed. A failed write restores earlier writes and reports
  files it could not restore.

Interface choices made by the prototype, open to revision:

- Plan input lists every member, with empty changes for unchanged ones, so an
  aligned package always has a known previous version. `previous` must exist in
  the package history.
- Alignment is the strategy result's `unchanged: "align" | "drift"`, set by the
  `unchanged` option of `VersionStrategy.semver`.
- A shared calculation without changes produces no versions, with or without
  `pre`.
- Generated modules export the version and, for prereleases, the line state as
  `prerelease`. The previous version is imported from its generated module or an
  explicit source.
- Source relocation accepts imports followed by exactly one
  `export const name = factory.make("id", ...)`. Dynamic imports, `import.meta`,
  re-exports, imports between pending modules, and name collisions are reported.
  The scanner reads text; it is not a TypeScript parser.

Product gaps that need a decision:

- Stable promotion contents (open question above). The prototype refuses with
  `StablePromotionUnsupported`.
- A literal target together with `pre`. The prototype refuses with
  `ExplicitTargetWithPre`.
- Dependents: proposals are reported, but a `release` proposal does not add a
  version and dependency ranges are not edited.
- `Release.Source.packageJson()` and loading recorded line state are not built.
  Previous versions are explicit input, and preparation checks manifests.
- One shared calculation cannot continue independent prerelease lines; such
  packages need separate settings.
