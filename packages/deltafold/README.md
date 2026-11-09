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
- [Leave an action to a person](#leave-an-action-to-a-person)
- [Simplify routes with rules and shortcuts](#simplify-routes-with-rules-and-shortcuts)
- [Render changelogs and guides](#render-changelogs-and-guides)

## Install

```sh
pnpm add deltafold effect
```

deltafold requires `effect` 4 as a peer dependency and a runtime with a global
`AbortSignal`, such as Node.js 22.18 or later, Deno, Bun, or a browser. Type
checking needs DOM or Node.js types for `AbortSignal`.

- `deltafold`: declarations, planning, handlers, interactions, observers, and executors.
- `deltafold/changelog`: changelog and document builders.
- `deltafold/cli`: `Command.make` and `Cli.run`, for a package's own migrator command.
- `deltafold/markdown` and `deltafold/html`: renderers for those documents.

Get plans and execution reports through deltafold's APIs. Patch-version
compatibility guarantees don't cover these structures when you construct them
by hand, such as a `Plan.Step` or an `Executor.Report`. If you create them
yourself, their required fields may change between patch releases.

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

Handlers bind to action instances. A handler either applies its action
directly, or first runs a read-only `prepare` phase. `prepare` returns
`Handler.prepared(value)`, and `apply` then receives that value, or
`Handler.skip(reason)`, which skips the action and reports the reason. In this
example, `renameKey` and `fileExists` stand for your own file access.

```ts
import { Executor, Handler } from "deltafold";

const handlers = [
	Handler.promise(renameTimeout, {
		prepare: async ({ file }) =>
			(await fileExists(file))
				? Handler.prepared()
				: Handler.skip("This project has no app.json"),
		apply: async (_prepared, { payload: { file, from, to }, signal }) => {
			await renameKey(file, from, to, { signal });
		},
	}),
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
- `dryRun: true` runs `prepare` phases and never runs `apply`. A prepare phase
  that may depend on an earlier action is reported `Undetermined`, because the
  dry run does not apply that action.
- `signal` cancels and `timeout` limits each phase; both reject with
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

Here `configFiles` is your implementation of the service. `Handler.effect`
also accepts `{ prepare, apply }`. Both phases run in the action's own scope,
so a resource acquired in `prepare`, such as a lock, stays open until the
action ends. To cancel an Effect
execution, interrupt its fiber; it ends as interrupted, without a report.

The handler array must cover every action of the history: a missing handler is
a type error that names the action. Use `Plan.withRuntimeCoverage(plan)` to
check coverage only at run time, before any action starts. `Handler.promise` can
declare services too, and `Executor.runPromise` then needs a `services` context
or layer that covers them.

## Leave an action to a person

An action is work that a migration requires. The handler decides who performs
it, so the same action can be manual in one environment and automated in
another. `Handler.manual` declares that a person does the work. It has no
prepare or apply phase and no text of its own: the person sees the instruction
or description that the migration already declares.

```ts
import { Executor, Handler, Interaction, type Plan } from "deltafold";

const handlers = [
	Handler.manual(renameTimeout, {
		verify: ({ file, to }) => hasKey(file, to),
	}),
];

// The migration's instruction for this action, or the action's description.
const textOf = ({ action, instruction }: Plan.Occurrence) =>
	instruction?.content
		.map((part) => (part._tag === "Text" ? part.text : part.action.description))
		.join("") ?? action.description;

const interaction = Interaction.promise(async ({ occurrence }, { signal }) =>
	(await ask(textOf(occurrence), { signal })) ? "confirmed" : "declined",
);

const report = await Executor.runPromise(plan, { handlers, interaction });
```

deltafold has no prompt of its own. The `interaction` asks the person, with
whatever terminal or interface the caller has, and answers `"confirmed"` or
`"declined"`. `ask` and `hasKey` stand for your own code.

- A confirmed occurrence is `Completed` with `performer: "manual"`. Its
  `confirmation` is `"asserted"` when the person said so and nothing checked it,
  or `"verified"` when the handler's optional `verify` check also passed.
  `verify` runs only after the confirmation. A check that returns `false` fails
  the occurrence with `VerificationFailed`. A passing check is evidence that the
  work is in place, not proof of how it was done.
- A declined occurrence is `Declined`. The run stops as it does after a failure
  and rejects with `ExecutionFailed`, which lists it under `declined`.
- A run whose plan has manual handlers and no `interaction` rejects with
  `InteractionUnavailable` before any action starts. This is checked at run
  time. An action without a handler is still a coverage error and never becomes
  manual work.
- `timeout` does not limit the wait for a person. To end the wait, abort the
  `signal` option of `runPromise`. The occurrence is then `Interrupted` in its
  `confirmation` phase, and the `signal` that the interaction receives aborts
  so it can stop asking.
- A dry run never asks, never runs `verify`, and needs no interaction. It
  reports `performer: "manual"` on the `WouldExecute` and `Undetermined`
  outcomes of manual occurrences.
- Parallel branches can ask at the same time. An interaction that owns one
  terminal queues its own prompts. A failure or a decline in one branch stops
  new actions, but a person who was already asked can still answer.
- Progress is not saved. Running the plan again asks again for manual work that
  was already confirmed.

`Handler.manualEffect` and `Interaction.effect` take an Effect check and an
Effect interaction, and keep their errors and services.

## Observe execution

Observers receive a run's events as they happen, for example to write logs or
show progress. Like handlers, they are an input of the run: pass them to the
executor's `observers` option.

```ts
import { Observer } from "deltafold";

const logging = Observer.effect((event) => Effect.logDebug(event._tag));

// Progress goes to stderr, so it stays out of the program's own output.
const progress = Observer.sync((event) => {
	if (event._tag !== "ActionSettled") return;
	const { finished, total } = event.progress.actions;
	console.error(`[${finished}/${total}] ${event.action.description}: ${event.outcome._tag}`);
});

await Executor.runPromise(plan, { handlers, observers: [logging, progress] });
```

`Observer.sync`, `Observer.promise`, and `Observer.effect` take a callback for
each event. An Effect observer's services become requirements of the execution.
The executor waits for each observer before it continues, so a slow observer
slows the run. A failing observer never changes the outcome; the report lists it
under `observation`.

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

## Ship a migrator command

`deltafold/cli` builds a command-line interface for your package from the same
declarations. Your consumers run it to inspect and apply migrations between your
versions. It is built on `effect/cli` and needs no platform code; your bin
supplies the runtime, for example `@effect/platform-node`:

```ts
#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { Cli, Command } from "deltafold/cli";
import { widgets } from "./history.js";

const command = Command.make(widgets, {
	name: "widgets-migrate",
	handlers: () => import("./handlers.js").then((module) => module.handlers),
});

Cli.run(command, { version: "2.0.0" }).pipe(
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
```

`Command.make` returns an ordinary `effect/cli` command. `Cli.run` runs it as the
program: it reports usage errors, sets exit statuses, and never prompts. The
command has these subcommands:

| Command     | What it does                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------- |
| `validate`  | Lists every declaration issue.                                                                |
| `plan`      | Resolves the route and instructions between `--from` and `--to`. Runs no handlers.            |
| `upgrades`  | Lists versions reachable by upgrade from `--from`, with their routes. `downgrades` likewise.  |
| `migrate`   | Runs the plan with your handlers. `--dry-run` only evaluates preconditions. Needs `handlers`. |
| `guide`     | Renders the upgrade or downgrade guide as Markdown or HTML (`--format`, `--output`).          |
| `changelog` | Renders the release history, or one `--release`. Needs `releases` metadata.                   |

When several routes connect two versions, the command fails and lists them;
pass `--route` with one of the listed identifiers, or `--policy`. A missing or
unknown version never falls back to another one.

Help, `validate`, `plan`, `upgrades`, `downgrades`, `guide`, and `changelog`
never load handlers or run preconditions. Pass `handlers` as a function that
imports the handler module, so that only `migrate` loads it. Importing the
module that declares your package still runs that module's top-level code.

Results go to stdout; progress, diagnostics, and errors go to stderr.
`--log-level` filters diagnostics only, never results or failures. Effect logs
from your handlers go to stderr; Promise handlers that write to stdout
themselves would mix with results. With `--json`, stdout holds one JSON document
with `schemaVersion: 1`, and a failure that happens before there is a result
prints one JSON error document on stderr instead, with a stable `reason`,
structured `data`, and suggested follow-up commands as `argv`. `migrate` always
prints its report on stdout, including after a failure or cancellation.
Action payloads are not included in JSON output.

| Exit status | Meaning                                                                               |
| ----------- | ------------------------------------------------------------------------------------- |
| 0           | Done, including an empty plan or a dry run whose checks pass.                         |
| 1           | The history, a handler, or the run failed. Completed actions were not rolled back.    |
| 2           | Invalid arguments, an unknown version or route, or a route the caller must choose.    |
| 130         | Interrupted. The report shows which actions completed and which may still be running. |

To ship one tool that migrates several related packages, build one command per
package and mount them as subcommands of your own `effect/cli` command, then run
that with `Cli.run`. Import `effect/cli` under another name, such as `EffectCli`,
so that its `Command` does not hide deltafold's. deltafold does not order
migrations across packages; your command decides that order. `effect/cli` is
marked unstable in Effect 4, so the command type can change with Effect releases.

```ts
import * as EffectCli from "effect/cli";

import { Cli, Command } from "deltafold/cli";

const acme = EffectCli.Command.make("acme").pipe(
	EffectCli.Command.withSubcommands([
		Command.make(widgets, { name: "widgets", handlers: widgetHandlers }),
		Command.make(gadgets, { name: "gadgets", handlers: gadgetHandlers }),
	]),
);

Cli.run(acme, { version: "1.0.0" }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
```

## License

[MIT](https://github.com/YLfjuk/deltafold/blob/main/LICENSE)
