# deltafold

deltafold models a package's version history and resolves the migration
instructions between two versions. You declare changes, actions, versions, and
migrations once. deltafold plans the route between two supported versions, runs
your handlers for the planned actions, and renders release notes and upgrade
guides from the same declarations.

The planner never reads or writes your consumers' files: handlers that you or
your consumers supply do the work, as Promise callbacks or Effect programs. The
API is experimental and may change before 1.0; open design choices are listed in
the repository's
[decisions](https://github.com/YLfjuk/deltafold/blob/main/notes/decisions.md).

- [Install](#install)
- [Declare a history](#declare-a-history)
- [Resolve a plan](#resolve-a-plan)
- [Run a plan with Promise handlers](#run-a-plan-with-promise-handlers)
- [Run a plan with Effect handlers](#run-a-plan-with-effect-handlers)
- [Simplify routes with rules and shortcuts](#simplify-routes-with-rules-and-shortcuts)
- [Render changelogs and guides](#render-changelogs-and-guides)

## Install

```sh
pnpm add deltafold effect
```

deltafold requires `effect` 4 as a peer dependency and a runtime with a global
`AbortSignal`, such as Node.js 22.18 or later, Deno, Bun, or a browser. Type
checking needs DOM or Node.js types for `AbortSignal`.

- `deltafold`: declarations, planning, handlers, and executors.
- `deltafold/changelog`: changelog and document builders.
- `deltafold/markdown` and `deltafold/html`: renderers for those documents.

## Declare a history

An action kind describes an operation and its payload. An action instance is
one concrete instruction with a stable identifier. A migration names exact
versions and interpolates the actions it performs.

```ts
import { Action, Change, History, Migration, Package, Version } from "deltafold";

const RenameKey = Action.define<{ file: string; from: string; to: string }>("config.rename", {
	describe: ({ file, from, to }) => `In ${file}, rename "${from}" to "${to}"`,
});

const renameTimeout = RenameKey.make("rename-timeout", {
	file: "app.json",
	from: "timeout",
	to: "requestTimeout",
});

const WidgetsChange = Change.define<{ readonly breaking: boolean }>();

const timeoutRenamed = WidgetsChange.make("2026-11-06.rename-timeout", { breaking: true })`
	Rename the timeout option to requestTimeout.
`;

const v1 = Version.make("1.0.0", { changes: [] });
const v2 = Version.make("2.0.0", { previous: v1, changes: [timeoutRenamed] });

const toV2 = Migration.make("1.0.0-to-2.0.0", { from: v1, to: v2, addresses: [timeoutRenamed] })`
	${Migration.instruction(renameTimeout)`Rename the timeout option. Its value stays in milliseconds.`}
`;

export const history = History.make({ versions: [v1, v2], migrations: [toV2] });
export const widgets = Package.make("@acme/widgets", { history });
```

`Version.changes` records what shipped in a release, and `Migration.addresses`
records which changes a transition handles. `Migration.instruction(action)`
attaches prose to one action, so the prose disappears from guides when a rule
removes that action. Use `Action.ref(action)` to mention an action without
running it again.

Declare a transition that needs no work with `Migration.noop`, so that "no
work" is never inferred from a missing migration:

```ts
const v201 = Version.make("2.0.1", { previous: v2, changes: [] });
const patch = Migration.noop("2.0.0-to-2.0.1", { from: v2, to: v201 });
```

A reverse transition exists only when you declare it. Register the result of
`Migration.withRevert` in place of the original migration:

```ts
const restoreTimeout = RenameKey.make("restore-timeout", {
	file: "app.json",
	from: "requestTimeout",
	to: "timeout",
});
const reversible = Migration.withRevert(toV2)`${restoreTimeout}`;
```

`History.validate(history)` returns every declaration problem at once.

## Resolve a plan

```ts
import { Result } from "effect";

const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
if (Result.isFailure(resolved)) throw new Error(resolved.failure.message);

const plan = resolved.success;
plan.route.id; // "1.0.0>2.0.0"
plan.occurrences.map((occurrence) => occurrence.id); // ["1.0.0-to-2.0.0/rename-timeout"]
```

Resolution returns a `Result` and needs no handlers; a plan with no actions is
valid. When several routes connect the versions, it fails with
`AmbiguousRoute`: pass one of the listed route identifiers as `route`, or
choose a
[route policy](https://github.com/YLfjuk/deltafold/blob/main/packages/deltafold/src/features/planning/resolve.ts)
with `policy`. The other failures are described by
[`ResolveError`](https://github.com/YLfjuk/deltafold/blob/main/packages/deltafold/src/features/planning/resolve-error.ts).

A route that deltafold finds never goes down to a shared ancestor and back up
to another branch. Moving between release branches needs a migration declared
between them, or a shortcut: a declared shortcut may pass through a shared
ancestor, because its author asserts that it is equivalent.
`History.upgrades` and `History.downgrades` list the reachable versions.

## Run a plan with Promise handlers

Handlers bind to action instances. A precondition that returns `false` skips the
action and reports the reason. In this example, `renameKey` and `fileExists`
stand for your own file access.

```ts
import { Executor, Handler } from "deltafold";

const handlers = [
	Handler.promise(
		renameTimeout,
		async ({ file, from, to }, { signal }) => {
			await renameKey(file, from, to, { signal });
		},
		{
			when: ({ file }) => fileExists(file),
			skipReason: "This project has no app.json",
		},
	),
];

try {
	const report = await Executor.runPromise(plan, { handlers });
} catch (error) {
	if (error instanceof Executor.ExecutionFailed) {
		for (const entry of error.report.occurrences) {
			console.log(entry.occurrence.id, entry.outcome._tag);
		}
	}
	throw error;
}
```

- The executor checks that every action has one matching handler before any
  action starts, and rejects with `HandlerCoverageError` otherwise.
- Migrations run one after another. On failure, no new action starts, actions
  that already started finish, and the run rejects with `ExecutionFailed` and
  the partial report.
- Nothing is rolled back and progress is not saved: running the plan again
  repeats completed actions.
- `dryRun: true` evaluates preconditions without running any action body. A
  precondition that may depend on an earlier action is reported `Undetermined`,
  because the dry run does not apply that action.
- `signal` cancels and `timeout` limits each action; both reject with
  `ExecutionInterrupted`. Cancellation is cooperative: a callback that ignores
  its signal can keep running after the run ends, and the report marks it as
  possibly still running.

Options, errors, and outcomes are documented on
[`Executor`](https://github.com/YLfjuk/deltafold/blob/main/packages/deltafold/src/features/execution/executor.ts)
and [`Handler`](https://github.com/YLfjuk/deltafold/blob/main/packages/deltafold/src/features/execution/handler.ts).

## Run a plan with Effect handlers

`Handler.effect` keeps the typed errors and services of its Effect. The
execution requires the handlers' services; provide them, then run it:

```ts
import { Context, Effect } from "effect";

const ConfigFiles = Context.Service<{
	readonly renameKey: (file: string, from: string, to: string) => Effect.Effect<void>;
}>("app/ConfigFiles");

const effectHandler = Handler.effect(renameTimeout, ({ file, from, to }) =>
	Effect.gen(function* () {
		const files = yield* ConfigFiles;
		yield* files.renameKey(file, from, to);
	}),
);

const report = await Effect.runPromise(
	Executor.effect(plan, { handlers: [effectHandler] }).pipe(
		Effect.provideService(ConfigFiles, configFiles),
	),
);
```

Here `configFiles` is your implementation of the service. To cancel an Effect
execution, interrupt its fiber; it ends as interrupted, without a report.

The handler array must cover every action of the history: a missing handler is
a type error that names the action. Use `Plan.withRuntimeCoverage(plan)` to
check coverage only at run time, before any action starts. `Handler.promise` can
declare services too, and `Executor.runPromise` then needs a `services` context
or layer that covers them.

## Simplify routes with rules and shortcuts

Rules replace consecutive actions when you assert that they are equivalent.
Replacements can feed other rules. Rules never match across parallel branches
or around a text-only migration.

```ts
import { Rule } from "deltafold";

const cancelRoundTrip = Rule.replace("cancel-timeout-round-trip", {
	match: [renameTimeout, restoreTimeout],
	replacement: [],
});
```

`Action.sequence` groups ordered actions. `Action.parallel` groups independent
branches, each of which may contain a sequence. A shortcut offers an alternative
to a named sequence of migrations, and must replace every migration of each hop
it covers.

## Render changelogs and guides

```ts
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";

const changelog = Changelog.make();

Markdown.render(changelog.upgrade(plan, { package: widgets }));
Markdown.render(
	changelog.history(widgets, {
		releases: [Version.withMetadata(v1, {}), Version.withMetadata(v2, {})],
	}),
);
```

`changelog.upgrade` prints the plan's resolved instructions; pass
`explain: true` to list what rules removed. `changelog.history` keeps every
historical change, including reverted ones, and needs one
`Version.withMetadata` annotation per release. `Html.render` from
`deltafold/html` renders the same documents as HTML.

Without sections, a release lists all of its changes under "Changes". Sections
group changes by their metadata, changes that no section selects go under "Other
changes", and annotations can carry release metadata, such as dates, for
plugins:

```ts
const sectioned = Changelog.make<{ date: string }>({
	sections: [
		Changelog.section("breaking", {
			title: "Breaking changes",
			select: (change) => change.metadata.breaking === true,
		}),
	],
});
```

Sections, plugins, and release annotations are documented on
[`Changelog`](https://github.com/YLfjuk/deltafold/blob/main/packages/deltafold/src/features/documents/changelog.ts)
and
[`Document`](https://github.com/YLfjuk/deltafold/blob/main/packages/deltafold/src/features/documents/document.ts).

## License

[MIT](https://github.com/YLfjuk/deltafold/blob/main/LICENSE)
