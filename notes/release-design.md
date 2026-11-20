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
		{
			package: widgets,
			files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }),
		},
		{
			package: widgetsReact,
			files: ReleaseFiles.at("packages/react", { manifest: "package.json" }),
		},
		{
			package: tools,
			version: toolsStrategy,
			files: { manifest: "packages/tools/package.json", versions: "packages/tools/history" },
		},
	],
	change: ProjectChange,
	version: SemVerStrategy.make({
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

// Previous versions and requirements come from manifests. A bare package stands for a
// member with no changes and no overrides.
const resolved = ReleaseFiles.resolve(release, {
	root: workspaceRoot,
	base: configDirectory,
	packages: [{ package: widgets, changes: widgetChanges }, widgetsReact, tools],
	input: { pre: { tag: "beta", continue: true } },
});
```

Release.make requires a stable group ID. Membership is bounded to registered
packages; plan input cannot silently introduce another package. Package/change
associations belong to release configuration/input, not to core Change or the
pending declaration. A shared change can be included for several packages.

Each member's previous version is, in order: a stated `previous`; in
`ReleaseFiles.resolve`, the manifest's version, always passed to plan as stated;
in a direct `release.plan` call, the single head of the package history, the one
version nothing descends from. A bare `Package`, or a member without `previous`,
uses that head. Several heads (for example a backport merged forward) refuse
with `PreviousRequired`, naming every such package and its heads; an empty
history refuses with `NoPrevious`. Each planned and unchanged member reports
`previousFrom: "stated" | "history-head"`, and an explanation names the head
used, noting when it is a prerelease. `Release.heads(pkg)` lists the heads. A
planned version must be new to the whole package history (`ExistingVersion`).

Releasing from a version that already has later versions forks beside them. It
is allowed for now: it can be intentional, or come from a stale manifest or a
bad merge. The plan's explanations note each such fork and the later versions.
A refusal with an explicit acknowledgement was considered and deferred.

Release.plan remains the one-off equivalent of a configured planner. Root
version settings supply a shared calculation; per-package overrides supply
independent versions or strategies. Only inheriting packages influence the
shared calculation. Literal target versions are plan input only, at the root or
per package. Release.make takes strategies only, in its type: a group is reused
across releases, so a fixed version there would apply to every future release.

Per-run options override configured defaults at the same level; per-package
options override root settings. Arrays replace arrays rather than concatenate.
Omitted defaults inherit; an empty list explicitly disables that list. Strategy
input, such as SemVer's `pre`, is an exception: it exists only on plan input and
never on Release.make. The plan's `input` goes to the shared calculation; a
package entry takes `input` only with its own `version` strategy, and the type
of each is its strategy's input type.

## Version strategies and baselines

The planner does not know any version format. A `VersionScheme<V>` names a
format and gives `decode`, `encode`, and an `order`. A `VersionStrategy` is a
callable built only by `VersionStrategy.make({ name, scheme, input?, calculate })`;
plain functions are refused (`NotAStrategy`). It receives `{ participants, input }`,
where each participant has its decoded `previous`, its `ancestry`, changes, and
dependency updates, and returns `{ version, versions?, unchanged?, details? }`.
`versions` gives individual participants another version or their own details.
`input` is a Standard Schema for per-plan input, required when the strategy
declares an input type; without it the input type is `undefined`. The planner
runs the schema synchronously before each calculation, refuses its issues and
asynchronous validation with `InvalidInput`, and passes the schema's output to
the strategy. Input is required in plan types when its type does not accept
`undefined`. Strategies must be pure and synchronous: the planner may
call one several times for a plan. `VersionStrategy.refuse(message)` reports
`StrategyRefused`, naming the strategy; any other thrown error, including a
`PlanError`, is reported as `InvalidStrategyResult`. Only the built-in SemVer
strategy's own diagnostics pass through as they are. External data is resolved before planning.

The planner decodes previous versions and literal targets, builds ancestry, runs
strategies, checks downgrades with the scheme's order, and encodes results. A
literal target is used exactly as written, with no strategy call: the scheme
decodes it for checks, and its spelling is kept.

`SemVerStrategy` is the optional built-in strategy. Its versions are Effect's
`SemVer.SemVer`, an unstable Effect module, so `effect` changes may need
adjustments here; a type contract test pins the shape, and CI may later run
against Effect's latest release. Its input is `{ pre?, target? }`, and each
planned version's `details.line` is the prerelease line it lands on.
`SemVerStrategy.encodeLine` turns a line into strings for output.

The baseline policy supports highest (default), require-matching, and an explicit
baseline version. A baseline is used for calculation, not assigned as ancestry.
An explicit baseline ignores alignment checks. An explicit target bypasses
calculation. Exact syntax for the richer baseline
policy remains a prototype detail.

Baseline policy also controls alignment. Align unchanged participants to an
advancing shared version by default; allow unchanged-package drift explicitly.
Accept drift in major/minor/patch numbers, prerelease counters and identifiers,
and mixed stable/prerelease versions. Highest selects one complete version by
SemVer precedence, never components from different versions. Each generated
version retains its package's actual previous-version reference. Reject targets
that downgrade a participant.

## Prerelease behavior

These rules belong to `SemVerStrategy`. Omitting `pre` from its input means
stable output. A prerelease requires the full object
`pre: { tag: string, continue: boolean }`; both fields are required. No boolean
or string shortcuts, inherited pre default, or configured-default-tag behavior.

continue false starts a prerelease line. continue true continues its target
unless bump intent requires a higher one. A target never lowers, so new patch
changes do not lower a line already preparing a major release.

Lines are derived, never recorded. `2.0.0-beta.3` is on the line with target
2.0.0 (the id without its prerelease part), tag `beta`, and counter 3; its
baseline is its nearest stable ancestor, found through `previous`. Only
prerelease ids shaped `<target>-<tag>.<counter>` form a line. Packages share a
line when target and tag match. Because the target never lowers, no accumulated
bump needs to be kept: escalation compares the new intent, applied to the
baseline, with the current target.

Example from stable 1.5.2: patch starts 1.5.3-beta.0; another patch continues at
1.5.3-beta.1; a major elevates to 2.0.0-beta.0; another patch continues at
2.0.0-beta.1. Reset the counter to zero when tag or numeric target changes;
otherwise increment it. No-downgrade checks still apply to tag transitions.
Continuing from a stable version, or from a prerelease that is not shaped like a
line, is a planning error.

A `target` given with `pre` is the stable version the line prepares, not the
prerelease itself: from 1.5.2, `input: { pre: { tag: "beta", continue: false },
target: "3.0.0" }` gives 3.0.0-beta.0, and continuing gives 3.0.0-beta.1.
Continuing never lowers a line's target, so a later calculated target below
3.0.0 keeps 3.0.0. A prerelease `target` with `pre` is an error, and a target
below the line fails the no-downgrade check. A plan-level literal `version` is
always the exact version.

The plan's configured tag determines the output identifier even with mixed
baselines. A shared calculation uses a consistent stage choice.

A shared calculation continues one line. Participants on a stable version
join it, following the group's alignment rule: in an aligned group they take the
shared prerelease version; in a drifting group they join the same line (target
and tag) with their own counter, starting at 0, and every package keeps its own
counter from then on. From widgets at 2.0.0-beta.1 and react at stable 1.5.2,
both with changes, an aligned group gives both 2.0.0-beta.2, and a drifting
group gives widgets 2.0.0-beta.2 and react 2.0.0-beta.0. Participants with
different lines cannot share a calculation.
Prerelease identifiers are arbitrary SemVer identifiers. npm dist-tags are out of
scope: they belong to the publish step.

Superseded: premajor/preminor/prepatch/prerelease as separate change bump values;
per-change pre intent; mixed-intention mode; pre true, pre "continue", and
inherited default tags. Use magnitude metadata plus the plan-level object.

### Stable promotion

A stable plan from a prerelease records exactly the changes it is given. The
author chooses them; deltafold does not collect them automatically. A change may
be left out because it was reverted on the line, or because it fixed a problem
only a prerelease had.

To help with the choice, `SemVerStrategy.prereleaseChanges(pkg, from)` lists the changes
on the line since its last stable ancestor. It follows `previous` and reports, for
each change, the prereleases that contain it and the changes on the line that
revert it or that it reverts. It selects nothing. A release CLI command will
present the same listing, and authors may use their own tooling instead.

The stable version is the line's target, raised when selected changes need a
stronger bump from the line's baseline. Promotion needs a line-shaped prerelease,
as continuing a line does.

## Dependency policy

DependentsPolicy.propose proposes required dependency edits and releases in the
plan. DependentsPolicy.explicit reports missing selections. Custom synchronous
policies are supported. Distinguish manifest edits from published releases,
especially for private packages and different dependency types. Resolve
propagation before review; apply never discovers new participants.

A dependent outside the group produces a cross-group requirement; it does not
silently expand group membership. Cross-group orchestration is not initial scope.

Range edits keep the operator: `^1.5.0` becomes `^2.0.0`, `~` stays `~`, and an
exact version is replaced. `workspace:` ranges are left to the package manager.
Whether a range is satisfied follows npm range semantics for any range SemVer
can parse: a prerelease satisfies only a range with a prerelease on the same
version, and build metadata is ignored. A satisfied range is left alone whatever
its form; other forms are refused only when they need an edit. Both built-in policies take
`updateRanges`: `"out-of-range"` (the default) edits a range only when the new
version falls outside it, and `"always"` edits it whenever the dependency is
released.

A release caused only by dependency updates records no changes. It joins the
version calculation as patch intent, so a group that aligns moves it to the
shared version, and a drifting group gives it its own patch. Planning repeats
until no new dependent release appears, so dependents of dependents are
included. The generated version module records the range edits as release
metadata, `Version.withMetadata(version, { dependencies })`, and
`ReleaseChangelog.dependencies`, from the `@deltafold/release/changelog`
entry, renders them as "Updated Dependencies".
Preparation refuses when a manifest's range no longer matches the edge the plan
used, or when `explicit` reports a missing selection.

## Files, pending inputs, and replacements

Global and package-local pending locations are authoring conveniences; folder
layout is not mandatory. Initial apply consumes all pending changes within the
configured release scope together. Partial consumption of shared inputs is
deferred. Do not introduce a per-package pending-consumption ledger initially.

Generate one file per version, with configurable directory and stable export
name. The file name is the version id verbatim, such as `1.6.0-beta.0.ts`.
Preparation refuses ids that cannot be a plain file name, with path separators
or `:`, for the new version and its previous one (`VersionFileName`).
Generated modules export the version and, when dependencies were updated, its
release metadata; they record no prerelease state. Custom output layouts are
deferred.

Every registration has `files`: a required `manifest` path and a `versions`
directory, written by hand or built by `ReleaseFiles.at(dir, { manifest,
versions? })`. `versions` defaults to `.deltafold/versions` inside `dir`.
deltafold never assumes a manifest name. A registration has no separate `dir`,
so a directory and explicit files can never conflict. The manifest is a path for
now; manifest adapters (for example `NpmManifest.at` or `CargoManifest.at`) may
replace it when other ecosystems arrive.

Relative paths in configuration and options resolve against the release config
file's directory, passed to the file layer as `base`; the release CLI will supply
it. Absolute paths are accepted only inside the workspace `root`, and anything
outside is refused with `OutsideWorkspace`, as are drive-relative Windows paths
such as `C:dir`. Manifest edits write version ids as JSON string content. Reports, edits, and requirement
manifests use workspace-relative paths. A `<root>/` prefix for workspace-relative
configuration is future work.

Build metadata (a `+...` suffix) is refused by `SemVerStrategy` in previous
versions, baselines, and targets, because it does not affect precedence. The
planner, the file layer, and core treat version ids as written; a literal target
that the scheme decodes passes through unchanged.

Lockfile updates are the user's responsibility for now: after apply, run the
package manager's install command so the lockfile matches the edited manifests.
The release CLI is intended to print that command. An opt-in `Lockfile.update`
step, backed by package-manager adapters, may run after apply later.

Copy selected declarations into each
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

`ReleaseFiles.resolve(release, options)` is the manifest-backed source. It reads
each member's `package.json`: `version` becomes the previous version, and the
`dependencies`, `peerDependencies`, `optionalDependencies`, and
`devDependencies` fields become requirements. `devDependencies` can get range
edits but never require a release, because they do not change what consumers
install. Optional `manifests` globs find dependents outside the group, which
are reported as cross-group requirements. Resolution returns the input and a
snapshot of what it read; preparation and apply refuse when any of it changed.

The plan reports versions, selected changes, generated records, dependency edits,
replacement locations/zero matches, pending cleanup, and explanations. Stale
pending files, manifests, or replacement targets cause refusal and replanning;
never recalculate an approved plan silently.

Apply modifies local files only. Preserve release records before consuming
pending inputs. Apply checks each file's expected contents again right before
writing it, and stops without overwriting a file that changed meanwhile
(`ChangedDuringApply`). On failure, it restores files changed by this operation
while they still hold its contents. Any other contents may be another writer's,
so the file is left as it is and reported in `unrestored`. That includes the
failed write's own file when it holds neither its old nor its new contents: a
partial write and an external edit cannot be told apart.
Directories created for new files, such as a fresh versions directory, are kept.
No crash-safe atomicity claim. Prototype safe reruns and interruption boundaries
before prescribing persistence machinery.

Git commits, tags, publishing, and publication metadata are separate explicit
steps. Core migration execution/rollback behavior is not release apply policy.

## Open prototype questions

- Source relocation: supported declaration/dependency patterns, factory import
  discovery and explicit reference fallback, collisions and diagnostics.
- Exact DependentsPolicy callback contract, rich baseline shape, and handling
  no-change plans. Do not infer new product policy from syntax examples.

## Deferred authoring tooling

Custom .change.delta/.version.delta files with filename-derived IDs and a
TypeScript content mapper are wanted, not initial implementation scope. Preserve
the same underlying models and optional ordinary TypeScript path. See
[wanted features](wanted-features.md). Evaluate the TypeScript 7.1 compiler API
for generation and in-memory validation without imposing it on core.

## Prototype findings

The prototype in `packages/release` is private and unpublished. It builds on
headless `Change` from the core. Its public exports carry `@since @next`. When the package
first receives a version, the version step replaces `@next` with that version on
the APIs the release includes, before publishing; tags that already name a
version keep it.

These contracts worked as accepted:

- Bounded groups with a required ID. Per-package settings leave the shared
  calculation, plan options replace configured ones, and literal targets work at
  both levels of plan input. Every generated version keeps its package's own `previous`.
- The configured factory's metadata type reaches strategies, and changes from
  another factory are type errors. Strategies are synchronous in their type and
  at run time.
- Highest, require-matching, and explicit baselines. Unchanged members align by
  default and drift when the strategy allows it. Downgrades fail.
- The prerelease sequence above, from lines derived from version ids and
  ancestry. Continuing from a stable version and a tag change that lowers
  precedence fail with diagnostics.
- Stable promotion with explicitly selected changes, and
  `SemVerStrategy.prereleaseChanges` listing a line's changes with their reverts.
- Pending modules copied into one generated module per version without
  evaluation. Relative imports are re-pointed and a shared change is copied into
  each package's module with the same ID.
- Literal replacements with globs, exclusions, zero-match reports, and overlap
  conflicts. Apply refuses when any file read during preparation, or the set of
  matched files, changed. A failed write restores earlier writes and reports
  files it could not restore.

Interface choices made by the prototype, open to revision:

- Plan input lists every member, so an aligned package always has a known
  previous version. A stated `previous` must exist in the package history.
- Alignment is the strategy result's `unchanged: "align" | "drift"`, set by the
  `unchanged` option of `SemVerStrategy.make`.
- A strategy over another scheme (a build number) plans end to end, including
  downgrade checks with its order.
- A shared calculation without changes produces no versions, whatever its input.
- Generated modules export the version, and release metadata for dependency
  updates. The previous version is imported from its generated module or an
  explicit source.
- Source relocation accepts imports followed by exactly one
  `export const name = factory.make("id", ...)`. Dynamic imports, `import.meta`,
  re-exports, further bindings in the same statement, regular expressions and
  division in the declaration, imports between pending modules (however their
  extension is spelled), and name collisions are reported. The scanner reads
  text; it is not a TypeScript parser.

Product gaps that need a decision:

- The release CLI: config discovery, plan and apply commands, the command that
  lists a line's changes for selection, and later `init`. It is a separate pull
  request.
- A `workspace:` range never triggers a dependent release.
- Packages on different prerelease lines cannot share a calculation; they need
  their own version settings.
