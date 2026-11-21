---
"deltafold": patch
---

Keep a package's name as a literal type. `Package.make("@acme/widgets", { history })` now returns `Package.Package<A, "@acme/widgets">`. `Package.Package` takes an optional second type parameter for the name, defaulting to `string`, so existing `Package.Package<A>` annotations stay compatible.
