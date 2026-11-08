# deltafold

deltafold models a package's version history and resolves the migration
instructions between two versions. You declare changes, actions, versions, and
migrations once. deltafold then plans the route between any two supported
versions, runs your handlers for the planned actions, and renders release notes
and upgrade guides from the same declarations.

The planner never reads or writes your consumers' files. Handlers that you or
your consumers supply do the work, and they can be Promise callbacks or native
Effect programs.

deltafold is in early development. Expect API changes before 1.0. Behavior that
is still a prototype choice is listed in the repository's
[decisions](https://github.com/YLfjuk/deltafold/blob/main/notes/decisions.md).

## Install

```sh
pnpm add deltafold effect
```

deltafold requires `effect` 4 as a peer dependency and a runtime with a global
`AbortSignal`, such as Node.js 22.18 or later, Deno, Bun, or a browser. Type
checking needs DOM or Node.js types for `AbortSignal`.

| Entry point           | Contents                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `deltafold`           | `Action`, `Change`, `Version`, `Migration`, `Rule`, `Shortcut`, `History`, `Package`, `Plan`, `Handler`, `Executor` |
| `deltafold/changelog` | `Changelog` and `Document` builders                                                                                 |
| `deltafold/markdown`  | `Markdown.render`                                                                                                   |
| `deltafold/html`      | `Html.render`                                                                                                       |

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

const timeoutRenamed = Change.make("2026-11-06.rename-timeout", {
	kind: "changed",
	breaking: true,
})`
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

`Version.changes` records what shipped in a release. `Migration.addresses`
records which changes a transition handles. `Migration.instruction(action)`
attaches prose to one action, so the prose disappears from guides when a rule
removes that action. Use `Action.ref(action)` to mention an action without
running it again.

Some transitions need no work. Declare them with `Migration.noop`, so that
"no work" never has to be inferred from a missing migration:

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

`History.validate(history)` returns every declaration problem at once, such as
duplicate identifiers, conflicting definitions, unregistered versions, an
action repeated in one migration, or an invalid shortcut.

## Resolve a plan

```ts
import { Result } from "effect";

const resolved = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
if (Result.isFailure(resolved)) throw new Error(resolved.failure.message);

const plan = resolved.success;
plan.route.id; // "1.0.0>2.0.0"
plan.occurrences.map((occurrence) => occurrence.id); // ["1.0.0-to-2.0.0/rename-timeout"]
```

Resolution returns a `Result` and needs no handlers. A plan with no actions is
valid. Failures have a `_tag`:

- `UnsupportedRoute`: no declared route connects the versions. It lists the
  reachable versions, the closest ones by release ancestry, and blockers.
- `AmbiguousRoute`: several routes connect the versions. Pass one of the listed
  route identifiers as `route`, or choose a `policy`: `"fewest-actions"`,
  `"fewest-migrations"`, `"lowest-cost"`, or `"prefer-shortcuts"`. A policy that
  leaves a tie still fails.
- `InvalidHistory`, `UnknownVersion`, `UnknownRoute`, `TooManyRoutes`,
  `RewriteCycle`, `ConflictingRewrites`, and `RewriteLimitExceeded`.

A route never goes down to a shared ancestor and back up to another branch.
Moving between release branches needs a migration declared between them.
`History.upgrades` and `History.downgrades` list the reachable versions.

## Run a plan with Promise handlers

Handlers bind to action instances. A precondition that returns `false` skips the
action and reports the reason. A precondition that throws fails the run. In this
example, `renameKey` and `fileExists` stand for your own file access.

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

Before any precondition or body runs, the executor checks that every occurrence
has exactly one handler for the same action definition. It rejects with
`HandlerCoverageError` otherwise. For an action produced by a rule, the error
names the rule and the actions it replaced.

Migrations run one after another. On failure, the executor starts no new
action, lets actions that already started finish, and rejects with
`ExecutionFailed`. The report lists completed, skipped, failed, and
unattempted occurrences. Completed actions are not rolled back, and progress is
not saved: running the plan again repeats them.

Rejections that none of a handler's `errors` guards recognize become
`UnexpectedHandlerError`, which keeps the cause and the action identifier.

Pass `dryRun: true` to evaluate preconditions without running any action body.
A precondition that depends on an earlier action reports `Undetermined`
because the dry run does not apply that action.

Pass `signal` to cancel. Cancellation stops new actions, interrupts running
ones, aborts the `signal` passed to Promise callbacks, and rejects with
`ExecutionInterrupted`. `timeout` interrupts one action that takes too long and
stops new ones. Both apply to dry-run preconditions too. Interrupted Promise
callbacks that ignore the signal may keep running; the report marks them
`settled: false` after `settleTimeout`.

## Run a plan with Effect handlers

`Handler.effect` keeps the errors and services of its Effect.
`Handler.promise` can declare services too, and receives them resolved. Either
handler below can perform `renameTimeout`:

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

const AsyncConfigFiles = Context.Service<{
	readonly renameKey: (
		file: string,
		from: string,
		to: string,
		options: { readonly signal: AbortSignal },
	) => Promise<void>;
}>("app/AsyncConfigFiles");

const promiseHandler = Handler.promise(
	renameTimeout,
	({ file, from, to }, { files, signal }) => files.renameKey(file, from, to, { signal }),
	{ services: { files: AsyncConfigFiles } },
);

const execution = Executor.effect(plan, { handlers: [effectHandler] });
```

To cancel an Effect execution, interrupt its fiber. Running actions are
interrupted and Promise callbacks receive an aborted signal; the effect ends as
interrupted, without a report.

The execution's requirements include the handlers' services. They also include a
`Handler.Binding` for every action of the history that the array does not
cover. Provide those with `Handler.layer([...])`, or use
`Plan.withRuntimeCoverage(plan)` to check coverage only at run time.
`Executor.runPromise` requires a `services` context or layer that covers the
requirements.

Integration modules can export their own handler factories. They return the same
`Handler` values and work with both executors.

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

const changelog = Changelog.make<{ date: string }>();

Markdown.render(changelog.upgrade(plan, { package: widgets }));
Markdown.render(
	changelog.history(widgets, {
		releases: [
			Version.withMetadata(v1, { date: "2026-10-01" }),
			Version.withMetadata(v2, { date: "2026-11-06" }),
		],
	}),
);
```

`changelog.history` keeps every historical change, including reverted ones.
`changelog.upgrade` prints the plan's resolved instructions; pass
`explain: true` to list what rules removed. Release metadata stays outside the
history as `Version.withMetadata` annotations. Missing, duplicate, or unrelated
annotations throw `ReleaseMetadataError`.

`Changelog.make` configures change sections and plugins.
`Document.Plugin.make` adds content at `Document.Title.pre`,
`Document.Title.post`, `Document.Body.pre`, or `Document.Body.post`, once per
release or once per history. `Html.render` from `deltafold/html` renders the
same documents as HTML.

## License

[MIT](https://github.com/YLfjuk/deltafold/blob/main/LICENSE)
