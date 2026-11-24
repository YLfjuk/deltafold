---
"deltafold": minor
---

Namespace all `Data.TaggedError` tags with `deltafold/<ErrorName>`.

Breaking: Every `deltafold` tagged error now sets `_tag` and `error.name` to `deltafold/<ErrorName>`. Update `Effect.catchTag("ExecutionFailed", ...)` to `Effect.catchTag("deltafold/ExecutionFailed", ...)`, and do the same for `Match.tag` or `_tag` checks. `instanceof` checks and non-error discriminated unions are unchanged.
