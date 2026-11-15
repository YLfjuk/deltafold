# deltafold

## 0.1.0

### Minor Changes

- 10ffbcd: Add prepare phases to handlers. `Handler.promise` and `Handler.effect` accept `{ prepare, apply }`: `prepare` reads state and returns `Handler.prepared(value)` or `Handler.skip(reason)`, and `apply` receives the prepared value. Dry runs run `prepare` and never `apply`. Both phases share one scope per action, and each phase has its own timeout.
  
  Breaking: the `when` and `skipReason` options are removed; move the check into `prepare`. Handler phases are now `"prepare"` and `"apply"`, and the dry-run outcome `PreconditionFailed` is now `PreparationFailed`. Effect handlers no longer require `Scope`. An interrupted Promise that has not settled keeps its action's scope and a services layer built by `Executor.runPromise` open until it settles.

## 0.0.1

### Patch Changes

- 281c269: Add the first public API. Declare changes, actions, versions, and migrations, then resolve plans between versions with `History.resolve`. Run plans with Promise or Effect handlers through `Executor.runPromise` or `Executor.effect`, including dry runs. Render release histories and upgrade guides with `deltafold/changelog`, `deltafold/markdown`, and `deltafold/html`.
