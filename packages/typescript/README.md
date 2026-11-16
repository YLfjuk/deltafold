# @deltafold/typescript

Handlers for [deltafold](https://github.com/YLfjuk/deltafold/tree/main/packages/deltafold)
that edit TypeScript, JavaScript, and JSON files with the TypeScript 7.1 compiler
API. A transform receives a parsed file, or a whole compiler project, and returns
text edits. The handler computes the edits in its prepare phase and writes them in
its apply phase, so a dry run shows whether any file would change without writing.

The package is experimental. It depends on TypeScript 7.1.0-beta, installed under
the alias `typescript-7.1`, until TypeScript 7.1 is stable. The design is in the
repository's
[codemod notes](https://github.com/YLfjuk/deltafold/blob/main/notes/codemod-typescript.md).

- [Install](#install)
- [Edit each file](#edit-each-file)
- [Edit a whole project](#edit-a-whole-project)
- [Run the handlers](#run-the-handlers)
- [Files, locks, and writes](#files-locks-and-writes)
- [Errors](#errors)
- [What find-references misses](#what-find-references-misses)

## Install

```sh
pnpm add @deltafold/typescript deltafold effect
```

`@deltafold/typescript/node` runs the compiler as a child process and needs
Node.js 22.19 or later. Type checking needs DOM or Node.js types for the
`AbortSignal` that Promise transforms receive.

- `@deltafold/typescript`: the `TypeScript` module with the handler constructors,
  edit types, errors, and the `TypeScript.Workspace` service.
- `@deltafold/typescript/node`: `TypeScriptNode.layer`, which provides the
  workspace with Node's file system and the compiler.

## Edit each file

`TypeScript.File.promise` runs a transform once per matched file. The transform
returns edits for its own file, against the text it received. The `edit` helpers
take syntax nodes and start at a node's first token, after its leading comments.

```ts
import { isImportDeclaration, isNamedImports, isStringLiteral } from "typescript-7.1/ast/is";

import { TypeScript } from "@deltafold/typescript";
import { Action } from "deltafold";

type RenameImport = { module: string; from: string; to: string; include: ReadonlyArray<string> };
const RenameImport = Action.define<RenameImport>("ts.rename-import");
const renameCreateClient = RenameImport.make("rename-create-client", {
	module: "@acme/widgets",
	from: "createClient",
	to: "makeClient",
	include: ["src/**/*.ts", "src/**/*.tsx"],
});

const renameImports = TypeScript.File.promise(
	renameCreateClient,
	async ({ sourceFile, edit, payload }) =>
		sourceFile.statements.flatMap((statement) => {
			if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier))
				return [];
			if (statement.moduleSpecifier.text !== payload.module) return [];
			const bindings = statement.importClause?.namedBindings;
			if (bindings === undefined || !isNamedImports(bindings)) return [];

			return bindings.elements
				.filter((element) => (element.propertyName ?? element.name).text === payload.from)
				.map((element) =>
					element.propertyName === undefined
						? edit.replace(element, `${payload.to} as ${element.name.text}`)
						: edit.replace(element.propertyName, payload.to),
				);
		}),
	{ include: ({ include }) => include },
);
```

The transform also receives `path`, `project`, `program`, `checker`, `signal`, and
the `services` it declares. `TypeScript.File.effect` takes an Effect transform that
keeps its own errors and services.

## Edit a whole project

`TypeScript.Project.promise` runs a transform once per compiler project, with that
project's matched files. `references(symbol)` runs the compiler's find-references
and returns the uses in those files only, so a field can be renamed wherever a
value of its type flows, whatever the variables are called.

```ts
const renameField = TypeScript.Project.promise(
	renameA1,
	async ({ payload, program, checker, references, edit }) => {
		const member = await findMember(program, checker, payload); // your lookup
		if (member === undefined) return [];

		return (await references(member)).map((reference) =>
			edit.rename(reference.node, payload.to),
		);
	},
	{ include: ({ include }) => include },
);
```

Each edit carries the root-relative path of its file. An edit to a file outside the
project's matched files fails the action. `edit.rename` keeps local names in
shorthand forms, so `const { a1 } = value` becomes `const { a2: a1 } = value`, and
refuses name positions it does not support.

Files outside every tsconfig file form an inferred project; `project.kind` tells the
transform which kind it received.

## Run the handlers

Handlers from this package are ordinary deltafold handlers, and a plan can mix them
with `Handler.promise` and `Handler.effect` handlers. They require
`TypeScript.Workspace`:

```ts
import { TypeScriptNode } from "@deltafold/typescript/node";
import { Executor } from "deltafold";

await Executor.runPromise(plan, {
	handlers: [renameImports, renameField],
	services: TypeScriptNode.layer({ root: process.cwd() }),
});
```

Payload globs are relative to `root`. Run a tool's migration once at the repository
root, and a library's migration once per package root.

## Files, locks, and writes

- Globs never match inside `node_modules`. The compiler still reads installed type
  declarations, but migrations edit only the developer's files.
- Patterns that are absolute or contain `..`, symbolic links, and junctions are
  refused.
- A handler locks every matched file before it reads them and holds the locks until
  its action ends. Custom handlers can take the same locks with
  `workspace.lock(paths)`.
- Offsets are UTF-16 positions in the text without its byte order mark. Edits in one
  file all refer to the text the transform received. Overlapping edits are refused;
  identical replacements are kept once.
- A byte order mark and line endings are kept. Edited JSON must still parse in the
  original's dialect.
- Writes go through temporary files: every file is staged, every original is checked
  against the content that was read, and then each is renamed into place. Nothing is
  rolled back.

## Errors

| Error             | Meaning                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `TransformFailed` | One or more transforms failed; nothing was written. `failures` lists each with its `project`, `path` for file transforms, and `cause`. |
| `WriteFailed`     | Writing failed. It lists the written, failed, and pending paths. A file that changed after it was read fails here.                     |
| `ReadFailed`      | A pattern, a link, or a file could not be read before any transform ran.                                                               |
| `CompilerFailed`  | The TypeScript compiler failed to start or crashed.                                                                                    |

A cause is the error a transform declared with `errors`, `UnknownError` for anything
else, `SyntaxErrors` for a matched file that does not parse, or `EditRejected` for
edits the adapter refuses. `TypeScript.causes(error, guard)` selects the failures a
guard recognizes.

## What find-references misses

The compiler does not report every use of a property. Check these by hand or in your
transform:

- `{ ...value, a1: 2 }`: still compiles after a rename but no longer overrides the
  field.
- Values typed as a union, such as `A | B`.
- String literals typed as `keyof A`.
- Generic code constrained by shape, such as `<T extends { a1: number }>`. The
  compiler reports these after the rename.
- Values typed `any`.
