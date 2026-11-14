---
"deltafold": minor
---

Add manual handlers. `Handler.manual` and `Handler.manualEffect` declare that a person performs an action, and the new `Interaction` module lets the caller of `Executor.runPromise` or `Executor.effect` ask that person through the `interaction` option. An optional `verify` check runs after the person confirms. A run with manual handlers and no interaction fails with `InteractionUnavailable` before it starts, and a dry run never asks.

Breaking: `Completed`, `WouldExecute`, and `Undetermined` outcomes gain a `performer` field, so exact comparisons with `{ _tag: "Completed" }` no longer match. Reports gain the `Declined` outcome and the `"confirmation"` and `"verification"` phases, and `ExecutionFailed` gains a `declined` list.
