# deltafold API design

Status: pre-implementation specification.

The package name is `deltafold`. The intended GitHub repository is
`YLfjuk/deltafold`. This document does not imply that the repository exists or that
the npm name is reserved. No library implementation is included.

The behavior described as agreed is the design contract. Code examples describe
the proposed authoring syntax, not tested exports or finalized TypeScript
signatures. Items marked open or prototype are intentionally undecided.

## Purpose and boundaries

deltafold models version history and resolves migration instructions between
versions, including an explicitly modeled `0.0.0` baseline. Authors declare changes,
actions, migrations, relationships, and shortcuts. Consumers receive an ordered
plan containing only the instructions retained after resolution.

The planner does not inspect or modify consumer code, configuration, files, or
databases. An optional executor runs consumer- or author-supplied handlers. The
same declarations can produce historical release notes and resolved upgrade or
downgrade instructions.

Three relationships remain separate:

- Release ancestry records which release a version descends from.
- Migration routes record supported transitions between exact version states.
- Execution bindings provide implementations for selected action instances.

Release history is never erased by migration optimization. The project targets
Effect 4 only initially. Consumers can use Promise handlers without learning
Effect, and can introduce native Effect handlers later without rewriting them.

## Changes and stable identities

A change is a human-readable logical change record. It can exist before being
assigned to a release, and does not require an executable migration.

```ts
export const timeoutRenamed = Change.make("2026-11-06.rename-timeout", {
  kind: "changed",
  breaking: true,
})`
  Rename the timeout configuration option to requestTimeout.
`;
```

The ID supports references, release membership, migration associations,
serialization, and explanations. Editing prose does not change identity.

- A later reintroduction of the same behavior is a new event with a new ID.
- The same logical change can appear in multiple release lines by referencing the
  same change record.
- An adapted backport can have its own ID and a `backportOf` reference.
- A date plus a descriptive suffix is a recommended convention, not a uniqueness
  guarantee. Authors must keep IDs stable and distinct within a history.
- Conflicting definitions of the same ID are errors. Referencing one definition
  from several places is valid.
- Matching change IDs do not automatically deduplicate action execution.

`reverts` describes a historical relationship. It does not establish executable
cancellation or an available downgrade route.

```ts
export const timeoutRestored = Change.make("2027-02-12.restore-timeout", {
  kind: "changed",
  breaking: true,
  reverts: [timeoutRenamed],
})`Restore the timeout configuration option.`;
```

The initial change-kind vocabulary should cover at least added, changed, removed,
and fixed changes. Final vocabulary and custom classification typing remain open.

## Action kinds and action instances

An action kind describes a consumer-owned operation and its payload. An instance
identifies one concrete instruction. The package does not interpret its domain.

```ts
export const RenameKey = Action.define<{
  target: string;
  from: string;
  to: string;
}>("config.rename", {
  describe: ({ target, from, to }) =>
    `In ${target}, rename "${from}" to "${to}"`,
});

export const renameExportA = RenameKey.make("rename-export-a-timeout", {
  target: "export-a",
  from: "timeout",
  to: "requestTimeout",
});

export const renameExportB = RenameKey.make("rename-export-b-timeout", {
  target: "export-b",
  from: "timeout",
  to: "requestTimeout",
});
```

`target` is domain data, not a built-in path or export selector. One kind can have
many independently implemented instances. Instance IDs identify instructions;
executions of those instructions are separate occurrences with their own reports.

Runtime payload schemas, imported-history validation, and transport formats need
prototype decisions before serialized plans become a supported feature.

## Versions and branching ancestry

Future versions reference their predecessors. Multiple versions may reference the
same predecessor; declaration order and semver sorting do not rewrite ancestry.

```ts
export const v0 = Version.make("0.0.0", { changes: [] });

export const v152 = Version.make("1.5.2", {
  previous: v151,
  changes: [],
});

export const v200 = Version.make("2.0.0", {
  previous: v152,
  changes: [timeoutRenamed],
});

export const v153 = Version.make("1.5.3", {
  previous: v152,
  changes: [securityFixed],
});
```

`v151` and `securityFixed` stand for earlier declarations in this excerpt.
Both v1.5.3 and v2.0.0 descend from v1.5.2. Publishing v1.5.3 after v2 does not
make it v2's predecessor.

Release ancestry must be acyclic. Migration routes can be cyclic because a reverse
transition can exist. Effect's Graph module is the intended graph implementation;
its exact use is an implementation detail. Merge ancestry and prerelease policy
are not yet specified.

## Migrations and tagged instructions

A migration names exact source and destination versions, references the changes
it addresses, and captures readable instructions containing action descriptors.

```ts
export const migrate152To200 = Migration.make("1.5.2-to-2.0.0", {
  from: v152,
  to: v200,
  addresses: [timeoutRenamed],
})`
  Update the configuration for export A:

  ${renameExportA}

  The value remains in milliseconds.
`;
```

Version.changes records which changes shipped in a release. Migration.addresses
references which logical changes that transition handles. These are separate
relationships to the same change records, not duplicate definitions. Handlers
bind to actions, not directly to change records. The migration field is addresses,
replacing the earlier changes spelling.

The template preserves text fragments and references rather than immediately
flattening them into a string. An action interpolation declares an action
occurrence. `Action.ref(action)` mentions an action without declaring another
occurrence. Scalar interpolation adds text; unsupported objects are errors.

Use an optional explicit instruction block to associate prose with an action
whose presence may change during optimization:

```ts
Migration.make("configure-v2", {
  from: v1,
  to: v2,
  addresses: [timeoutRenamed, retriesAdded],
})`
  ${Migration.instruction(renameTimeout)`
    Rename the timeout option, keeping its existing value.
  `}

  ${Migration.instruction(addRetryLimit)`
    Add a retry limit. Start with a limit of three.
  `}
`;
```

The block declares its action occurrence exactly once; it is not an additional
execution around an already interpolated action. Plain action interpolation
remains available for simple instructions.

- A retained action retains its instruction block in the resolved guide.
- A cancelled action loses its associated block from the resolved guide.
- A replacement uses its own action description or explicitly supplied replacement
  instruction, not automatically the original action's prose. Exact replacement
  instruction authoring syntax still needs prototype validation.
- Unassociated migration-level prose is shared context while any actions survive.
  If optimization removes every action, omit the migration section from the normal
  resolved guide. This does not silently erase a deliberately authored text-only
  instruction merely because it had no executable actions to begin with.
- An explanation view can expose omitted instructions and the responsible rule
  through retained provenance.
- Historical release notes and original migration declarations remain intact.

Do not infer prose ownership by sentence position. Authors use instruction blocks
when prose should disappear with its action. Behavior and ergonomic syntax for
blocks associated with action groups need prototype validation.

Action occurrences are sequential by default within a migration. Explicit groups
may declare independent branches for concurrent execution, as described under
executor ordering below. The proposed `requires` field
records explicit migration dependencies; textual mentions do not imply them.
The semantics of dependency satisfaction when rules remove or replace actions
need a prototype.

Migrations are registered independently of versions so routes can be added later
without circular declarations or changing published release definitions.

```ts
export const history = History.make({
  versions: [v0, v151, v152, v153, v200],
  migrations: [migrate152To200, migrate153To200],
  rules: [],
  shortcuts: [],
});
```

A v1.5.3-to-v2 route must explicitly address the backport's state. Sharing an
ancestor does not prove that a v1.5.2-to-v2 migration applies to v1.5.3.
Declare a supported zero-work transition with Migration.noop:

```ts
const patchUpgrade = Migration.noop("1.5.2-to-1.5.3", {
  from: v152,
  to: v153,
  addresses: [securityFixed],
});
```

It registers an explicit directed edge with no executable actions or required
handlers. Addresses is optional when no change association is useful. Noop asserts
that the transition as a whole requires no consumer work; it must not be used to
silence missing migration support for changes that actually need instructions.
This is appropriate, for example, for a patch that fixes internal package behavior
without requiring consumers to update their configuration or data.

Not supplying a direct migration leaves that edge absent, but another declared
route may still connect the endpoints. If no route exists, resolution reports
unsupported migration; it must not infer no work. A noop supplies a known valid
route and may connect otherwise separated executable migrations. A plan containing
only noops is a valid empty-action plan, with its route and explanation retained.
An ordinary route may also optimize to an empty-action plan through rules.

Noop is directed like any migration and does not implicitly declare downgrade
support. A reverse zero-work transition must be explicitly declared; exact
reversible-noop convenience syntax remains open. Skipping an action through a
handler precondition is an execution outcome, not a declarative noop edge.

Multiple migrations with identical endpoints can be complementary, such as JSON
and YAML configuration migrations whose handlers check applicability. They must
not automatically be treated as exclusive alternative routes. The representation
of complementary transition groups versus alternative routes is an open design
task for the routing prototype.

## Replacement rules and shortcuts

Rules are explicit, author-supplied equivalence assertions. deltafold validates
their structure and use; it cannot prove arbitrary consumer behavior equivalent.

```ts
const cancelRoundTrip = Rule.replace("cancel-timeout-round-trip", {
  match: [renameTimeout, restoreTimeout],
  replacement: [],
});

const combineRenames = Rule.replace("combine-renames", {
  match: [renameAtoB, renameBtoC],
  replacement: [renameAtoC],
});
```

Cancellation, composition, and supersession use the same replacement mechanism.
Rules initially match consecutive action sequences. They must not silently remove
operations around an intervening action that depends on the intermediate state.

Chaining is agreed: a replacement can feed another rule. For example, A-to-C
produced from A-to-B and B-to-C can combine with C-to-D. Resolution reports rewrite
cycles and conflicting outcomes instead of relying on registration order.

Preserve ordered replacement provenance. The implementation may dereference a
replacement back to its original sequence when useful, but provenance expansion
must not become a rewrite loop or weaken applicability requirements. Termination,
overlap detection, and equivalent-outcome comparison need prototype validation.

Shortcuts express explicit alternative transitions:

```ts
const fastUpgrade = Shortcut.make("fast-upgrade", {
  from: v201,
  to: v208,
  replaces: [
    migrate202,
    migrate203,
    migrate204,
    migrate205,
    migrate206,
    migrate207,
    migrate208,
  ],
  migrations: [migrateDirectlyTo208],
});
```

The author asserts equivalence to the named canonical route. A shortcut must not
claim replacement of an unrelated version sequence. Whether and how the resolver
automatically prefers a shortcut is part of the open route-selection decision.

Route selection is deliberately open for UX/DX trials. Compare explicit route
preferences, action-count minimization, and author-declared costs. Do not silently
settle this policy while implementing graph traversal.

## Planning, reversal, and reachability

```ts
const result = History.resolve(history, {
  from: "1.5.3",
  to: "2.0.0",
});
```

Resolution returns a discriminated success/error result. A successful plan retains
the endpoints, route, ordered optimized steps, relevant changes, and explanations
of replacements or omissions. Each step remains traceable to its action,
migration, and source change records. An empty optimized plan is valid.

Unknown versions, missing routes, dependency errors, rewrite cycles, and
conflicting resolution outcomes are explicit failures. Partial resolution must
not be presented as a complete executable plan. Planning requires no handlers or
execution services.

Reverse migrations are optional and separately declared:

```ts
const reversible152To200 = Migration.withRevert(migrate152To200)`
  Restore the previous configuration:

  ${restoreTimeout}
`;
```

Register the returned migration in place of the original. Reverse endpoints are
derived from the forward transition. No reverse declaration means no reverse edge.
Cancellation rules do not imply invertibility. Forward shortcuts do not imply
reverse shortcuts.

A reverse migration must be valid for the declared source state. If it needs a
backup from a prior execution, that requirement must be explicit; a source version
alone does not establish that a backup exists. Exact representation remains open.

```ts
History.upgrades(history, { from: v153 });
History.downgrades(history, { from: v200 });
```

These return reachable destination versions and route summaries, not all paths
through a potentially cyclic graph. A failed downgrade request should report
reachable downgrades, blockers, and the closest reachable alternatives. It must
never execute a fallback without a consumer choice.

The candidate definition of closest is proximity to the requested target along
release ancestry, returning ties when branching makes the answer ambiguous.
Direction policy, mixed upgrade/downgrade routes, and exact distance semantics
remain part of the routing prototype. Sharing an ancestor does not authorize a
downgrade-and-upgrade detour.

## Handler implementations and preconditions

Handlers bind to action instances initially. Kind-wide fallback bindings are not
part of the initial agreed API.

```ts
const jsonHandler = Handler.promise(
  jsonAction,
  async payload => {
    await updateJsonConfig(payload);
  },
  {
    when: async payload => usesJsonConfig(payload),
    skipReason: "This project does not use JSON configuration",
  },
);

const exportBHandler = Handler.effect(
  renameExportB,
  payload =>
    Effect.gen(function* () {
      const editor = yield* ExportBEditor;
      yield* editor.renameKey(payload);
    }),
  {
    when: payload => usesExportBConfigEffect(payload),
    skipReason: "Export B configuration is absent",
  },
);
```

These helpers and services are consumer-defined examples, not built-in filesystem
or configuration APIs. `Handler.promise` lazily adapts the callback through
`Effect.tryPromise`; `Effect.try` would only address synchronous computation.
`Handler.effect` accepts a callback returning an Effect. Generator users employ
Effect's own generator helpers. There is no custom Promise/Effect/iterator
auto-detection in the agreed handler interface.

The optional third argument holds handler options. Promise preconditions return a
boolean or Promise of a boolean. Effect preconditions return an Effect of a
boolean, contributing their own errors and service requirements.

Additional proposed Promise handler capabilities: explicitly declare required
services in the options and receive their resolved implementations through a
second callback argument. A services map containing an editor service key would
type the callback's editor value and add that key to the handler's Effect
requirements. Both execute and precondition callbacks need the same
service-resolution contract. Preserve registrations without service options;
exact signatures require the typing prototype.

Promise rejection types cannot be inferred from Promise's type parameter. Allow
authors to declare recognizable error schemas/guards and classify rejections at
the adapter boundary. Recognized failures retain a useful declared error union;
unrecognized failures become a tagged UnexpectedHandlerError carrying a cause of
type unknown, along with action identity. Do not expose E | unknown as the typed
error channel: that union collapses to unknown. Declaring errors does not prove
that a callback only throws those errors. Exact schema/guard options remain open.

- Absent precondition: execute the selected action occurrence.
- True: execute it.
- False: emit a skip event with its explanation.
- Failed precondition: report a failure, not a skip.

Handler checks provide applicability without planner-level consumer facts. A
generic plan and its printed instructions can include JSON and YAML actions while
each handler checks its own applicability during execution.

The distinction between an optional skip and an unmet requirement that blocks
dependent steps needs an explicit contract before execution is implemented.
Precondition side effects are prohibited by contract, not something TypeScript
can prove.

## Executors, reports, dry runs, and recovery

Both handler constructors produce the same internal Effect-based representation.
Both executor interfaces accept a mixed collection:

```ts
const handlers = [jsonHandler, exportBHandler];

const execution = Executor.effect(plan, { handlers });

await Executor.runPromise(plan, {
  handlers,
  services: editorServices,
  dryRun: true,
});
```

`Executor.effect` exposes typed errors and unsatisfied Effect requirements.
`Executor.runPromise` supplies required services and exposes Promise completion.
The exact service-supply and handler-layer signatures require a type prototype.
Promise handler rejections retain the original cause and action identity in a
handler failure; native Effect handlers preserve their typed requirements/errors.

Consumers must be able to provide handlers via Effect layers, with missing
statically known bindings visible in the requirements type. Dynamic route
selection can require a conservative action union; runtime-loaded plans require
validation and runtime coverage checks. Prove this behavior rather than promising
exact compile-time narrowing after runtime optimization.

Validate handler coverage before any selected action body executes. Migration
boundaries are sequential dependency barriers: later migrations assume successful
completion of the preceding migrations in the selected route. Within a migration,
execute action occurrences sequentially by default, with explicit concurrency
groups as an opt-in. The default failure policy is to stop and return/report:

- completed action occurrences;
- skipped occurrences and reasons;
- the failed occurrence and whether the failure was in its precondition or body;
- unattempted occurrences.

A failed action may have made partial changes. Do not call it rolled back or
unapplied. The Effect-facing error must carry the partial report; the Promise
interface must make it accessible on failure. Exact report and error types remain
to be specified.

Retry and rollback are optional configuration capabilities, disabled by default.
Retries require an explicit policy and an action safe to repeat or a declared
recovery mechanism. Rollback requires supplied execution undo behavior. Version
downgrade instructions are not automatically execution undo handlers. Recovery
failures must retain the original failure and partial report. Exact configuration,
retry boundaries, undo order, and recovery after a partially failed body are open.

Dry-run mode never invokes action bodies. It evaluates applicable read-only
preconditions and emits structured events suitable for a console reporter:

- would execute;
- would skip, with reason;
- undetermined, with reason;
- precondition failure.

Checks in later migrations are conservatively treated as depending on completion
of earlier migrations. Within a migration, checks follow the declared sequential
and parallel structure. A check behind an unapplied potentially mutating step is
undetermined, rather than a definite prediction based on current state. A check
on an explicitly independent branch can be evaluated without waiting for another
branch's simulated effects. A check failure still remains a failure, not a skip.
Do not infer independence from arbitrary callback code or merely from a numeric
concurrency limit. Dry runs must not retry or undo action bodies.

### Explicit execution groups

The composer can opt into concurrent independent work within a migration while
keeping dependent actions sequential. Reuse Effect's bounded/unbounded concurrency
semantics in the executor; preserve declarations in the plan so reporters and dry
runs see the same dependency structure. Exact authoring syntax needs a prototype.

Illustrative grouping API, not finalized names:

```ts
const tasks = Action.parallel([
  Action.sequence([createConfig, updateCreatedConfig]),
  updateIndependentSource,
], { concurrency: "unbounded" });
```

The config sequence may run alongside the independent source action, but its
second action waits for its first. The migration barrier waits for every branch
before starting the next migration. An explicit parallel group asserts branch
independence; the concurrency limit only controls scheduling within that group.

Keep these groups as declarative action-plan nodes, not opaque handler callbacks
that invoke other handlers. Otherwise coverage validation, replacement rules,
occurrence identities, dry-run checks, and reporting cannot discover the nested
steps. Handlers can use ordinary implementation helpers, but steps promised as
independently tracked migrations/actions must remain in the declared plan.

Optimization must preserve group ordering and migration barriers. Ordinary rules
simplify within a sequential branch and do not match across parallel branches.
Broader replacements require explicit structural rules matching the group
structure. Do not flatten independent branches into an arbitrary order and apply
consecutive-action rules to that order. Final execution-tree and structural-rule
syntax need prototype validation; the branch-local default is agreed.

On concurrent failure, stop admitting new actions across all branches and let
already-started actions settle. Do not automatically interrupt sibling action
bodies because another branch failed. A sibling's next sequential action and the
next migration must not start. Collect all actual outcomes before final reporting
or optional retry/rollback; recovery must not race a still-running action. Explicit
cancellation and configured timeouts are separate policies, not implied by a
sibling failure. If an action never settles, report execution as still pending
rather than claiming it has stopped. Detailed recovery order remains open.

Planning and document generation remain usable without execution implementations.
Supported routing, handler coverage, and runtime executability are separate
properties. Promise cancellation cannot undo or stop external work automatically.
Expose AbortSignal to Promise handler execute and precondition callbacks through
their second callback argument, alongside explicitly resolved services. Forward
the signal supplied by Effect.tryPromise rather than building a separate native
Effect cancellation mechanism. Reserve the signal name in that context so a
consumer service cannot shadow it. Example syntax, pending callback-context typing:

```ts
Handler.promise(
  updateRemoteConfig,
  async (payload, { signal, editor }) => {
    await editor.update(payload, { signal });
  },
  { services: { editor: ConfigEditor } },
);
```

The executor controls cancellation through Effect's interruption semantics.
Explicit execution cancellation and configured timeouts request interruption and
the Promise adapter's signal abortion; a sibling failure does not abort it under
the agreed settle-in-flight policy. Native Effect handlers do not require a
separately injected signal. They use native interruption and obtain an AbortSignal
through Effect.tryPromise when bridging to a Promise API.
Signal abortion is cooperative: code that ignores it may keep changing external
state. Do not equate an aborted signal or interrupted waiting fiber with physical
completion of the underlying operation. The bridge between Effect interruption,
signal lifetime, actual settlement, and reporting needs targeted prototype tests.
Reference: [Effect.tryPromise signal signature](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts).

### Optional local durability investigation

Investigate reusing a durable workflow engine for optional persisted execution
and resume instead of designing a new workflow runtime. Keep this outside the
platform-independent planner. It must not force every consumer to configure
persistence or install a hosted provider.

First candidate: Effect 4 workflow activities, ClusterWorkflowEngine, and
SingleRunner with SQL-backed storage using a local SQLite file. SingleRunner is
documented for embedded single-process setups without runner communication. The
workflow/cluster modules are currently marked unstable; prototype their
restart, serialization, configuration, and dependency costs before adoption.
The in-memory WorkflowEngine layer is not durable across process restarts.

This can reuse recorded completed activities, but does not make an arbitrary
filesystem write atomic with saving the activity result. A crash after the write
and before the result is persisted may repeat that activity. Resume must preserve
stable occurrence identity and the chosen plan, detect incompatible definition
changes, and distinguish recorded completion from an interrupted/uncertain step.
Non-idempotent uncertain steps need explicit recovery rather than an unconditional
retry. Default stop-on-failure and opt-in retry/rollback policy remain unchanged.

Other investigated options: Workflow SDK's local world needs no external service,
but its documentation identifies it as a development backend and notes its
in-memory queue does not persist across server restarts. DBOS TypeScript's current
configuration documentation requires Postgres for its system database, so it is
not the first choice for a file-only embedded CLI. Do not infer TypeScript SQLite
support from documentation for a different DBOS language SDK.

Primary references for this investigation:

- [Effect SingleRunner](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/cluster/SingleRunner.ts)
- [Effect SQL message storage, including SQLite](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/cluster/SqlMessageStorage.ts)
- [Effect Activity result recording](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/workflow/Activity.ts)
- [Workflow SDK Local World limitations](https://workflow-sdk.dev/worlds/local)
- [DBOS TypeScript configuration](https://docs.dbos.dev/typescript/reference/configuration)

## Release metadata annotations

History and core version records do not need publication metadata. Authors can
append independently exported annotations during release tooling:

```ts
type ReleaseMetadata = {
  releasedAt: string;
  commit: string;
  contributors?: readonly {
    name: string;
    url?: string;
  }[];
};

export const release200 = Version.withMetadata(v200, {
  releasedAt: "2026-11-06T12:00:00Z",
  commit: "abc123",
  contributors: [{ name: "Alice" }],
} satisfies ReleaseMetadata);
```

`Version.withMetadata` returns a typed `{ version, metadata }` annotation. It does
not mutate or replace the version registered in history. This is separate from
earlier proposals to enrich history itself; no history metadata update API is
needed.

```ts
changelog.release(widgets, release200);

changelog.history(widgets, {
  releases: [release152, release153, release200],
});
```

Consumers maintain independent exports and an array of annotations, not a required
record keyed by version. Matching by stable version identity happens internally.
Duplicate annotations and missing annotations for included releases are document
generation errors. The configured metadata type establishes required fields;
optional fields are handled by plugins. Core imposes no universal date, commit,
or contributors contract. External metadata needs runtime validation before it is
trusted; an optional metadata schema is proposed but not yet specified.

Acquiring metadata belongs to release tooling before document generation. Date
sorting for presentation must not alter release ancestry or migration routes.
Default history display ordering is still to be specified.

## Shared package definition

Package identity belongs to the shared domain model, not to changelog
configuration. A named package composes its history and can be supplied to
changelog, CLI, and other modules without repeating a package name.

```ts
export const widgets = Package.make("@acme/widgets", {
  history,
});
```

This is the package being modeled, not the deltafold library's own npm identity.
The definition owns the name once and references its history. It contains no
renderer settings, release metadata annotations, or execution handlers. The
changelog definition remains reusable across packages.

Existing History APIs can operate on `widgets.history`. Package-aware entry points
should retain package identity in their contexts and reports. Exact conveniences
for planning through Package versus History need to be finalized; do not duplicate
the routing implementation. Validation of releases against the supplied package
history prevents unrelated release annotations from being rendered under its name.

## Changelog configuration and sections

`Changelog.make` configures reusable document construction, separate from rendering:

```ts
const changelog = Changelog.make<ReleaseMetadata>({
  sections: [
    Changelog.section("breaking", {
      title: "Breaking changes",
      select: change => change.breaking,
    }),
    Changelog.section("features", {
      title: "Features",
      select: change => change.kind === "added",
    }),
    Changelog.section("fixes", {
      title: "Fixes",
      select: change => change.kind === "fixed",
    }),
  ],
  plugins: [commitPlugin, contributorsPlugin],
});
```

The supplied Package definition identifies the package whose changelog is being
generated. A full history document uses its name for the outermost title by
default. Release titles and plugin titles remain nested below it. The package
definition is available in document/plugin context. Exact title override syntax
and whether a standalone release includes a package wrapper are presentation
details for the document prototype. Name changes do not create migration edges
or alter route selection. No package name is configured on Changelog.make or
repeated in release metadata annotations.

First matching section wins. Each change appears once, empty sections disappear,
and unmatched changes enter a default Other changes section unless configured
otherwise. Breaking status is independent of feature/fix classification.

Document builders include:

```ts
changelog.change(timeoutRenamed);
changelog.release(widgets, release200);
changelog.history(widgets, { releases });
changelog.upgrade(plan);
```

`release` returns the changelog section for one release. `history` preserves
historical changes, including reverted ones. `upgrade` prints resolved migration
instructions and can explain omissions. Downgrade guide naming, metadata inputs
for plan documents, and which plugins apply to each document kind remain open.

Builders return document values. Renderers produce formatted strings:

```ts
Markdown.render(changelog.release(widgets, release200));
Html.render(changelog.release(widgets, release200));
```

## Document nodes, plugins, and insertion points

Plugins can contribute small annotations or whole sections. They operate on
format-neutral content and must not fetch metadata or execute migrations.

```ts
const contributorsPlugin =
  Document.Plugin.make<ReleaseMetadata>("contributors", {
    scope: Document.Release,
    at: Document.Body.post,
    resolve: ({ version, metadata }) => {
      if (!metadata.contributors?.length) return null;

      return Document.Section("contributors", {
        title: Document.Title("Contributors"),
        children: [
          Document.List(
            metadata.contributors.map(person =>
              person.url
                ? Document.Link(person.name, person.url)
                : Document.Text(person.name),
            ),
          ),
        ],
      });
    },
  });
```

`version` is available to plugins that need it; this example only uses metadata.
Lists accept individual items, not a comma-joined string.

```ts
Document.Title("Contributors");
Document.Title("Contributors", { level: 3 });
Document.Title("Contributors").pipe(Document.withLevel(3));

Document.Section("contributors").pipe(
  Document.withTitle("Contributors"),
  Document.append(Document.List([Document.Text("Alice")])),
);
```

Constructors produce nodes; pipeable transformations modify node values.
Automatic heading levels follow section nesting. Explicit levels are absolute
overrides. Unsupported levels are errors rather than silently clamped values.

Named insertion points such as `Document.Title.pre`, `Document.Title.post`,
`Document.Body.pre`, and `Document.Body.post` are interpreted inside an explicit
scope. A release-scoped plugin runs once per included release, including a release
inside a history document. A history-scoped plugin runs once for the whole history.

- Pre/post insertion produces sibling content around the selected document part.
- Configuration order resolves ordering at a shared insertion point.
- Plugin output is inserted once; new titles do not trigger recursive plugin runs.
- Section IDs are unique within their containing release, not across all releases.
- Unsupported scope/insertion combinations and duplicate section IDs are errors.

The plugin model replaces the earlier makeDetail and beforeRelease/afterRelease
proposals. Cross-plugin section references are deferred. Scope-specific plugin
context types and built-in anchor boundaries need prototype validation.

## Document backend prototype

Use the proposed Document API while evaluating mdast for ordinary headings,
paragraphs, lists, links, and code. Keep a small deltafold-owned semantic layer for
release sections, stable IDs, insertion points, provenance, and automatic heading
levels. Resolve that layer before lowering content into a serializer's AST.

The mdast choice is provisional. Test contributors, links, nested release/change
sections, explicit/automatic headings, Markdown escaping, and HTML output before
committing. Reuse existing serializers instead of implementing general formatting
and escaping. Foldkit is not selected as the core document representation.

Relevant primary references:

- [mdast specification](https://github.com/syntax-tree/mdast)
- [Effect Graph source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Graph.ts)
- [Effect 4 creation and Promise adaptation](https://effect.website/docs/v4/getting-started/creating-effects)
- [Effect 4 service requirements](https://effect.website/docs/v4/requirements-management/services)
- [Alchemy typed interpolation inspiration](https://x.com/samgoodwin89/status/2067868213069918404)

## CLI requirement and proposed entry point

Provide a ready-made migration/changelog CLI or a reusable CLI builder that
composers can expose from their own package. Shared flags, help, reporting,
exit behavior, and log-level handling are requirements. A proposed delivery is a
builder plus a thin built-in binary using the same command definitions, rather
than maintaining two command implementations. Packaging and exact syntax are not
yet agreed.

CLI implementation is deferred until the prototypes and main package logic have
been exercised. Initial official CLI runtime support is Node.js only. Keep core
modeling/planning and document-generation modules platform-independent; Node
filesystem/process dependencies belong at explicit runtime boundaries.

The composer reports having registered the `@deltafold` npm scope. Packaging
candidates include a separate `@deltafold/cli` package, or general command
definitions at `deltafold/cli` with Node startup/runtime wiring at
`deltafold/cli/node`. These are alternatives, not a requirement to ship both.
Choose after the prototype establishes the actual dependency boundary. Exact
minimum Node version and executable distribution remain open. The examples below
illustrate command behavior and do not commit to an export layout.

Illustrative entry-point configuration:

```ts
import { Cli } from "deltafold/cli";

export const cli = Cli.make({
  package: widgets,
  handlers,
  changelog,
  releases: [release152, release153, release200],
});
```

A built-in binary could load that named export:

```sh
deltafold changelog --entry ./deltafold.config.js --format markdown
deltafold migrate --entry ./deltafold.config.js --from 1.5.3 --to 2.0.0 --dry-run
deltafold migrate --entry ./deltafold.config.js --from 1.5.3 --to 2.0.0 --log-level warn
```

A composer-owned executable could call `Cli.run(cli)` using the same parser and
command implementation. Its package identity and default branding come from the
shared Package definition; an executable alias is separate CLI presentation
configuration, not a second package identity. The entry-point loader must not start migration bodies
merely to discover exports. Entry modules remain executable consumer code; a
dry-run flag is not an import sandbox. TypeScript entry loading, export selection,
runtime services, and runtime support need a concrete proposal before setup.

Required command capabilities cover changelog generation, migration planning and
application, dry runs, and inspection of available upgrade/downgrade destinations.
Relevant shared options include source/target versions, entry point, output format
and destination, log level, and noninteractive reporting. Recovery flags must map
to the eventual explicitly configured recovery policy, not create independent
CLI-only semantics. Unsupported or ambiguous routes fail instead of guessing.

Logging and output contracts:

- Generated Markdown/HTML or structured command results go to stdout unless an
  output destination is selected. Diagnostics and progress go to stderr.
- The selected log level filters deltafold logs, Effect logs under its execution
  runtime, and integrated adapter logs. Quiet output disables progress displays.
- Document/result output is not a diagnostic log and is not suppressed merely by
  changing log level. Failures still produce a nonzero exit status when logging
  is disabled.
- Machine-readable output must remain parseable, with no spinners, banners, ANSI
  decoration, or unsolicited summaries mixed into the data stream.
- Provide a logging/reporting capability to handler implementations and adapters.
  Arbitrary consumer `console.log` calls cannot be reliably controlled by Effect's
  log level. Do not patch the process-global console to pretend otherwise.
- A subprocess adapter must deliberately capture, classify, and route tool output
  if it promises log-level compliance. It must report structured tool failures even
  when the tool returns normally rather than rejecting its Promise.

The final command tree, option spellings, precedence between flags and config,
exit-code taxonomy, and log-level vocabulary remain to be specified.

## Handler interoperability and optional migration engines

Handlers are the agreed execution extension boundary. Action instances already
describe tagged intentions and planning returns those descriptors as ordered
steps with provenance. Do not add a second intention representation or a separate
Migrator abstraction for integrations.

An official submodule, separate integration package, or third-party package can
export handler factories. Those factories produce the same public Handler values
as Handler.promise and Handler.effect, and work with both existing executors.
No executor-specific engine registry or private handler construction is required.

Illustrative external module API, not a selected package name or engine:

```ts
const codemodHandler = Codemod.handler(renameExportA, {
  transform: renameExportATransform,
  include: ["src/**/*.ts"],
});

const handlers = [jsonHandler, codemodHandler, exportBHandler];

const execution = Executor.effect(plan, { handlers });
```

Handler is a supported public contract with inferred action payload/identity,
error, and Effect requirement types. Module factories should normally construct
handlers through Handler.promise or Handler.effect rather than fabricating
internal records. Final type signatures require the handler typing prototype.

All handler factories must participate in the same instance binding, coverage
validation, precondition handling, structured reporting, dry-run suppression,
cancellation, and explicitly configured recovery behavior. Engine-specific
configuration stays inside the integration. Runtime capabilities are supplied
through the supported execution context and Effect services, with an ergonomic
logging/cancellation bridge for Promise callbacks. That bridge's exact signature
is still open.

The executor must not identify an engine by inspecting imports or concrete handler
types. Integrations must not run transforms during handler registration or
planning. Optimization continues to inspect declared action descriptors, not
opaque transform implementations.

Code transformation engines are optional execution integrations. The core must
not assume JavaScript/TypeScript, source files, ASTs, parsers, or a specific engine.
Candidates include zmod, jscodeshift, ts-morph, and structural pattern tools such
as GritQL. These are candidates, not selected dependencies or equal substitutes.

The packaging choice remains open: an official submodule, a separate codemod
package, engine-specific packages, or third-party packages can all use this
contract. The composer has registered the `@deltafold` npm scope; no particular
codemod package name or integration has been selected.
Begin integration evaluation with worked examples before extracting shared
engine abstractions.

An integration can earn its boundary by normalizing tool errors, cancellation,
logging, file selection, preview results, and runtime services. Optimization still
requires explicit action relationships; a codemod engine cannot establish that
arbitrary transforms commute or cancel.

A deltafold dry run must continue to skip action bodies. An engine's own dry/preview
mode can execute transform code while suppressing file writes; it does not prove
that arbitrary transform callbacks have no other side effects. A future explicit
preview capability must distinguish those guarantees rather than silently call
handlers under the dry-run flag.

Engine references inspected for this proposal:

- [zmod run implementation](https://github.com/NaamuKim/zmod/blob/main/packages/zmod/src/run.ts)
- [jscodeshift](https://github.com/meta/jscodeshift)
- [ts-morph](https://ts-morph.com/)
- [GritQL](https://github.com/biomejs/gritql)

## Prototype acceptance scenarios

These are meaningful behavior and type checks for later prototypes, not claims
that an implementation or test suite already exists.

1. Model 0.0.0 through the latest registered version, including explicit empty
   transitions; distinguish an empty valid plan from an absent route.
2. Publish v1.5.3 from v1.5.2 after v2.0.0; preserve both ancestry branches and
   migrate v1.5.3 to v2 only through declared support.
3. Keep complementary JSON/YAML migrations together while offering separately
   declared alternative routes. Compare route-selection UX/DX on both cases.
4. Cancel two declared inverse actions across versions. Starting between those
   versions still produces the needed reverse instruction. Do not cancel around
   an unaccounted-for action using the intermediate state.
5. Chain replacements through an intermediate result, preserve provenance, and
   report cycles/conflicting outcomes without hanging or using registration order.
6. Validate shortcut endpoints and replaced route membership, then compare route
   policies without making one the permanent default.
7. Report supported, unsupported, and partially reachable downgrade requests;
   distinguish downgrade migration support from partial-execution undo support.
8. Run mixed Promise and native Effect handlers without refactoring old callbacks.
   Prove payload inference, missing-handler requirements, and callback/precondition
   service requirements with positive and negative TypeScript checks.
9. Report a false precondition as skipped, a rejected precondition as failed, and
   stop by default on failure with completed/failed/unattempted occurrences intact.
10. In dry run, invoke no action bodies. Show conditional predictions honestly when
    a check depends on unapplied earlier actions.
11. Bind different implementations to two instances of the same action kind.
    Reject missing bindings before action execution begins.
12. Render a draft change and an annotated release; generate a full history from
    appendable metadata exports without enriching history's version records.
13. Generate historical notes retaining reverted changes and a resolved guide
    omitting cancelled actions. Retain provenance for their different outputs.
14. Run release/history plugins once at their scoped anchors. Render section
    nesting, lists, links, and escaped content in both Markdown and HTML.
15. Define package identity once through Package.make and use it natively in
    changelog documents and the CLI. The full changelog uses its name for the
    outermost title without a Changelog.make name option or repeated release
    metadata fields. Preserve metadata-free history and renderer-free identity.
16. Exercise changelog and migration commands through a shared CLI definition;
    verify log-level filtering, separate output/diagnostic streams, noninteractive
    failures, and no action-body execution during dry runs.
17. Mix a third-party module-produced handler with Promise and Effect handlers in
    both executors without engine-specific executor logic. Validate payload and
    requirement inference, preconditions, reporting, dry-run suppression, and any
    adapter preview promises against actual tool behavior.

## Project setup boundary

The intended implementation is a TypeScript library targeting Effect 4. The
repository will be public from the start and use the MIT license. pnpm is the
provisional workspace package-manager choice. Initial CLI support targets Node.js;
library modeling/planning and document modules remain platform-independent.
Exact entry points, dependency/peer-dependency placement, minimum runtime versions,
publishing setup, and initial release scope remain to be chosen during setup.
The proposed root exports cover modeling/planning; executor, changelog, document,
Markdown, and HTML APIs can use subpath entry points once boundaries are validated.
Prototype the core API before implementing the deferred CLI or choosing its
separate-package versus subpath distribution.

Applicable workspace preferences call for a monorepo shape when implementation
begins, Turborepo for task ordering, Oxc for linting/formatting, and Changesets for
package releases. Do not scaffold unused packages merely to mirror this document.
Trial Vite+ as the consolidated development toolchain for testing, linting,
formatting, and library packaging where appropriate. Keep Turborepo responsible
for workspace task ordering and caching; do not adopt Vite Task's overlapping
orchestration merely because it ships with Vite+. Keep pnpm for workspace
dependency management. Vite+'s bundled Oxlint/Oxfmt align with the existing Oxc
preference. Use its library packaging capability rather than assuming an
application build is the correct library build. Verify actual task inputs,
outputs, and cache behavior in the tooling trial. This is not yet a dependency
installation or a commitment to keep Vite+ if the trial exposes problems.

Tooling references: [Vite+ guide](https://viteplus.dev/guide/),
[configuration](https://viteplus.dev/config/), and
[task runner](https://viteplus.dev/guide/run).

Release-tool adapters, such as nx release or Changesets integrations, should
produce the same public metadata annotations rather than requiring special core
history records.

No implementation, dependency installation, git initialization, GitHub repository
creation, publication, or account mutation is part of this specification step.
