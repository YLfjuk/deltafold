---
"deltafold": patch
---

Observe execution as it happens. Create observers with `Observer.sync`, `Observer.promise`, or `Observer.effect`, and pass them to the executor's new `observers` option alongside handlers. Events report each step, each action's phases and outcome, and progress counted in the optimized plan. Observer failures are recorded in the new `report.observation` field and never change the outcome. Plan steps now have a stable `id`.
