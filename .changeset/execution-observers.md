---
"deltafold": minor
---

Observe execution as it happens. Create observers with `Observer.sync`, `Observer.promise`, or `Observer.effect`, attach them to a package with `Package.withObserver`, and pass `pkg.observers` to the executor's `observers` option. Events report each step, each action's phases and outcome, and progress counted in the optimized plan. Observer failures are recorded in the new `report.observation` field and never change the outcome. Plan steps now have a stable `id`.
