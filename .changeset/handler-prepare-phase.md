---
"deltafold": minor
---

Add prepare phases to handlers. `Handler.promise` and `Handler.effect` accept `{ prepare, apply }`: `prepare` reads state and returns `Handler.prepared(value)` or `Handler.skip(reason)`, and `apply` receives the prepared value. Dry runs run `prepare` and never `apply`. Both phases share one scope per action, and each phase has its own timeout.

Breaking: the `when` and `skipReason` options are removed; move the check into `prepare`. Handler phases are now `"prepare"` and `"apply"`, and the dry-run outcome `PreconditionFailed` is now `PreparationFailed`. Effect handlers no longer require `Scope`. An interrupted Promise that has not settled keeps its action's scope and a services layer built by `Executor.runPromise` open until it settles.
