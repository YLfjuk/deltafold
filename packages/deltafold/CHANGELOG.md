# deltafold

## 0.2.1

### Patch Changes

- 02714b9: Observe execution as it happens. Create observers with `Observer.sync`, `Observer.promise`, or `Observer.effect`, and pass them to the executor's new `observers` option alongside handlers. Events report each step, each action's phases and outcome, and progress counted in the optimized plan. Observer failures are recorded in the new `report.observation` field and never change the outcome. Plan steps now have a stable `id`.
- 6ba38a3: Correct API `@since` tags to their first published versions

## 0.2.0

### Minor Changes

- 9a04de2: Add manual handlers. `Handler.manual` and `Handler.manualEffect` declare that a person performs an action, and the new `Interaction` module lets the caller of `Executor.runPromise` or `Executor.effect` ask that person through the `interaction` option. An optional `verify` check runs after the person confirms. A run with manual handlers and no interaction fails with `InteractionUnavailable` before it starts, and a dry run never asks.

  Breaking: `Completed`, `WouldExecute`, and `Undetermined` outcomes gain a `performer` field, so exact comparisons with `{ _tag: "Completed" }` no longer match. Reports gain the `Declined` outcome and the `"confirmation"` and `"verification"` phases, and `ExecutionFailed` gains a `declined` list.

## 0.1.0

### Minor Changes

- 10ffbcd: Add prepare phases to handlers. `Handler.promise` and `Handler.effect` accept `{ prepare, apply }`: `prepare` reads state and returns `Handler.prepared(value)` or `Handler.skip(reason)`, and `apply` receives the prepared value. Dry runs run `prepare` and never `apply`. Both phases share one scope per action, and each phase has its own timeout.
  
  Breaking: the `when` and `skipReason` options are removed; move the check into `prepare`. Handler phases are now `"prepare"` and `"apply"`, and the dry-run outcome `PreconditionFailed` is now `PreparationFailed`. Effect handlers no longer require `Scope`. An interrupted Promise that has not settled keeps its action's scope and a services layer built by `Executor.runPromise` open until it settles.

## 0.0.1

### Patch Changes

- 281c269: Add the first public API. Declare changes, actions, versions, and migrations, then resolve plans between versions with `History.resolve`. Run plans with Promise or Effect handlers through `Executor.runPromise` or `Executor.effect`, including dry runs. Render release histories and upgrade guides with `deltafold/changelog`, `deltafold/markdown`, and `deltafold/html`.
