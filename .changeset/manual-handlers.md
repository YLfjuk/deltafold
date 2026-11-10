---
"deltafold": minor
---

Add manual handlers. `Handler.manual` and `Handler.manualEffect` declare that a person performs an action, and the new `Interaction` module lets the caller of `Executor.runPromise` or `Executor.effect` ask that person through the `interaction` option. Reports gain the `Declined` outcome, the `confirmation` and `verification` phases, and a `performer` field on `Completed` and `WouldExecute` outcomes. A run with manual handlers and no interaction fails with `InteractionUnavailable` before it starts. `ExecutionFailed` gains a `declined` list.
