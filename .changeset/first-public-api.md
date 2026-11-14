---
"deltafold": patch
---

Add the first public API. Declare changes, actions, versions, and migrations, then resolve plans between versions with `History.resolve`. Run plans with Promise or Effect handlers through `Executor.runPromise` or `Executor.effect`, including dry runs. Render release histories and upgrade guides with `deltafold/changelog`, `deltafold/markdown`, and `deltafold/html`.
