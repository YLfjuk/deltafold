---
"deltafold": patch
---

Keep a package's name as a literal type: `Package.make("@acme/widgets", { history })` now returns `Package<A, "@acme/widgets">`. `Package` takes an optional second type parameter for the name, which defaults to `string`, so existing code is unchanged.
