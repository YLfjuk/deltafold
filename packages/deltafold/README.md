# deltafold

deltafold models a package's version history and resolves migration instructions
between versions. Declare changes, actions, versions, and migrations once.
deltafold plans routes between supported versions, runs handlers you supply
through Promise callbacks or Effect programs, and renders changelogs and upgrade
guides from those declarations.

The planner never reads or writes your consumers' files.

- [Install](#install)
- [Declare a history](#declare-a-history)
- [Resolve a plan](#resolve-a-plan)
- [Run a plan with Promise handlers](#run-a-plan-with-promise-handlers)
- [Run a plan with Effect handlers](#run-a-plan-with-effect-handlers)
- [Leave an action to a person](#leave-an-action-to-a-person)
- [Observe execution](#observe-execution)
- [Simplify routes with rules and shortcuts](#simplify-routes-with-rules-and-shortcuts)
- [Render changelogs and guides](#render-changelogs-and-guides)
- [License](#license)

## Install

```sh
pnpm add deltafold effect
```

deltafold requires `effect` 4 as a peer dependency and a runtime with a global
`AbortSignal`, such as Node.js 22.18 or later, Deno, Bun, or a browser. Type
checking needs DOM or Node.js types for `AbortSignal`.

- `deltafold`: declarations, planning, handlers, interactions, observers, and executors.
- `deltafold/changelog`: changelog and document builders.
- `deltafold/markdown` and `deltafold/html`: renderers for those documents.

Obtain plans and execution reports through deltafold's APIs. Patch-version
compatibility does not cover `Plan.Step` or `Executor.Report` objects built by
hand, as their fields may change between patch releases.

## Declare a history

An action kind describes an operation and its payload. An action instance is one
concrete instruction with a stable identifier. A migration names exact versions
and interpolates the actions it runs.

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

`Migration.instruction(action)` attaches prose to one action so guides omit
that prose if a rule removes the action. Use `Action.ref(action)` to mention an
action without running it again.

Declare a transition that needs no work with `Migration.noop`, so that missing
migrations never imply empty transitions.

```ts
const v201 = Version.make("2.0.1", { previous: v2, changes: [] });
const patch = Migration.noop("2.0.0-to-2.0.1", { from: v2, to: v201 });
```

A reverse transition exists only when declared. Register the result of
`Migration.withRevert` in place of the original migration.

```ts
const restoreTimeout = RenameKey.make("restore-timeout", {
	file: "app.json",
	from: "requestTimeout",
	to: "timeout",
});
const reversible = Migration.withRevert(toV2)`${restoreTimeout}`;
```

`History.validate(history)` reports every declaration issue at once.

## Resolve a plan

```ts
import { Result } from "effect";

const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
if (Result.isFailure(resolved)) throw new Error(resolved.failure.message);

const plan = resolved.success;
plan.route.id; // "1.0.0>2.0.0"
plan.occurrences.map((occurrence) => occurrence.id); // ["1.0.0-to-2.0.0/rename-timeout"]
```

Planning needs no handlers; a plan with no actions is
valid. When several routes connect the versions, resolution fails with
`History.AmbiguousRoute`. Pass a listed route identifier as `route`, or choose a
`policy` among `"fewest-actions"`, `"fewest-migrations"`, `"lowest-cost"`, or
`"prefer-shortcuts"`. Other failures return a `History.ResolveError`.

A route never downgrades to a shared ancestor and upgrades onto another branch.
Moving between release branches requires a migration between them, or a shortcut
asserting equivalence across that path. `History.upgrades` and
`History.downgrades` list reachable versions.

## Run a plan with Promise handlers

Handlers bind to action instances. A handler either applies its action directly,
or first runs a read-only `prepare` phase. `prepare` returns
`Handler.prepared(value)` so `apply` receives that value, or
`Handler.skip(reason)` to skip the action with a reason. In this example,
`renameKey` and `fileExists` represent your own file operations.

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
- Migrations run sequentially. After a failure, no new action starts, running
  actions finish, and the run rejects with `ExecutionFailed` carrying the
  partial report.
- Nothing is rolled back and progress is not saved. Running the plan again
  repeats completed actions.
- `dryRun: true` runs `prepare` phases without `apply`. A prepare phase whose
  result could depend on an earlier action reports `Undetermined`.
- `signal` cancels and `timeout` limits each phase, rejecting with
  `ExecutionInterrupted`. Cancellation is cooperative. A callback that ignores
  its signal can keep running after the run ends, and the report marks it as
  possibly still running.

`Executor.runPromise` also accepts `interaction`, `observers`, `runId`, and
`settleTimeout`. Tagged errors use the `deltafold/<ErrorName>` tag format for
`Effect.catchTag`.

## Run a plan with Effect handlers

`Handler.effect` keeps the typed errors and services of its Effect. Execution
requires the handlers' services; provide them before running.

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

Here `configFiles` supplies your `ConfigFiles` service. `Handler.effect` also
accepts `{ prepare, apply }`. Both phases share the action's scope, so a
resource acquired in `prepare`, such as a lock, closes after the action ends.
Interrupting an Effect run stops its fiber as interrupted without returning a
report.

By default, the handler array must cover every action of the history at compile
time. Passing `Plan.withRuntimeCoverage(plan)` defers coverage checking to run
time before any action starts. `Handler.promise` can declare `services` too,
which `Executor.runPromise` receives via a `services` context or layer.

## Leave an action to a person

An action represents work a migration requires. The handler decides who performs
it, so one action can be manual in one environment and automated in another.
`Handler.manual` marks an action for a person to complete. It has no `prepare`
or `apply` phase and adds no prose of its own; the person sees the instruction
or description declared on the migration.

```ts
import { Executor, Handler, Interaction } from "deltafold";
import type { Plan } from "deltafold";

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

deltafold supplies no prompt interface. Your `interaction` asks the person
through your terminal or UI and answers `"confirmed"` or `"declined"`. `ask` and
`hasKey` represent your own functions.

- Confirmed actions complete with `performer: "manual"`. When no `verify` check
  runs, `confirmation` is `"asserted"`; when `verify` runs and passes,
  `confirmation` is `"verified"`. Failing `verify` fails the occurrence with
  `VerificationFailed`.
- Declined actions produce a `Declined` outcome. Execution stops and rejects
  with `ExecutionFailed`, listing them under `declined`.
- A run with manual handlers and no `interaction` rejects with
  `InteractionUnavailable` before any action starts. Unhandled actions still
  fail coverage checks.
- `timeout` never limits manual confirmation waits. Abort `signal` on
  `runPromise` to interrupt the `"confirmation"` phase and propagate abort to
  `interaction`.
- `dryRun: true` never prompts, never runs `verify`, and needs no interaction.
  It reports `performer: "manual"` on `WouldExecute` and `Undetermined`
  outcomes.
- Parallel branches may prompt concurrently; terminal-based interactions should
  serialize prompts. Failure or decline stops new actions, while pending prompts
  can still finish.
- Progress is not saved. Rerunning the plan prompts again for manual actions.

`Handler.manualEffect` and `Interaction.effect` support Effect-based checks and
interactions while keeping their errors and service requirements.

## Observe execution

Observers receive execution events in real time for logging or progress output.
Pass them to the executor's `observers` option alongside handlers.

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

Use `Observer.promise` for asynchronous callbacks. Effect observers contribute
their service requirements to execution. The executor awaits each observer
before continuing, and records observer failures in `report.observation` without
changing run outcomes.

## Simplify routes with rules and shortcuts

Rules replace consecutive actions asserted to be equivalent, and chained
replacements can feed other rules. Rules never match across parallel branches or
around text-only migrations.

```ts
import { Rule } from "deltafold";

const cancelRoundTrip = Rule.replace("cancel-timeout-round-trip", {
	match: [renameTimeout, restoreTimeout],
	replacement: [],
});
```

`Action.sequence` orders actions, and `Action.parallel` groups independent
branches. A shortcut provides an alternate route over a named sequence of
migrations and must replace every migration along those hops.

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

`changelog.upgrade` renders a plan's resolved instructions; pass
`explain: true` to include rule omissions. `changelog.history` includes every
historical change, including reverted ones, using one `Version.withMetadata`
annotation per release. `Html.render` from `deltafold/html` renders HTML.

Without configured sections, a release places all changes under "Changes".
`Changelog.section` groups changes by metadata, leaving unmatched changes under
"Other changes". Annotations can also carry per-release metadata such as dates
for custom blocks built with `Document.Plugin.make`.

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

## License

[MIT](https://github.com/YLfjuk/deltafold/blob/main/LICENSE)
