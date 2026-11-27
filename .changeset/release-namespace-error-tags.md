---
"@deltafold/release": patch
---

Namespace all `Data.TaggedError` tags with `@deltafold/release/<ErrorName>`.

Breaking: `PlanError`, `PrepareError`, `StalePlan`, `ApplyFailed`, and `ChangedDuringApply` now set `_tag` and `error.name` to `@deltafold/release/<ErrorName>`. Update `Effect.catchTag`, `Match.tag`, and `_tag` checks accordingly; `instanceof` checks and non-error unions are unchanged.
