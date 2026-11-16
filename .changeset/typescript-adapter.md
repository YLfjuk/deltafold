---
"@deltafold/typescript": minor
---

Add `@deltafold/typescript`, deltafold handlers that edit TypeScript, JavaScript, and JSON files with the TypeScript 7.1 compiler API. `TypeScript.File.promise` and `TypeScript.File.effect` run a transform once per matched file; `TypeScript.Project.promise` and `TypeScript.Project.effect` run it once per compiler project, with find-references limited to the project's matched files. Handlers compute edits in their prepare phase, so dry runs report whether any file would change, and write them through temporary files in their apply phase. `TypeScriptNode.layer` from `@deltafold/typescript/node` provides the workspace with Node's file system and the compiler.
