# @deltafold/typescript

[deltafold](https://github.com/YLfjuk/deltafold/tree/main/packages/deltafold)
handlers that edit TypeScript, JavaScript, and JSON files. You write a transform
that takes a parsed file, or a whole compiler project, and returns text edits. The
transform works with syntax trees, programs, and checkers from the TypeScript 7.1
compiler API. The handler computes the edits in its prepare phase and writes them
in its apply phase, so a dry run shows which actions would change files without
writing any.

The package is experimental.

## Install

```sh
pnpm add @deltafold/typescript deltafold effect
```

If your transforms import the compiler's AST helpers or types, such as
`typescript-7.1/ast/is` in the examples below, install the compiler under the same
alias:

```sh
pnpm add typescript-7.1@npm:typescript@7.1.0-beta
```

The package has two entry points:

- `@deltafold/typescript` exports the `TypeScript` module: the handler
  constructors, edit types, errors, and the `TypeScript.Workspace` service.
- `@deltafold/typescript/node` exports `TypeScriptNode.layer`, which provides the
  workspace with Node's file system and the compiler. It runs the compiler as a
  child process and needs Node.js 22.19 or later.

Promise transforms receive an `AbortSignal`, so type checking needs DOM or Node.js
types.

## Edit each file

`TypeScript.File.promise` runs a transform once per matched file. The transform
returns edits for that file, with offsets into the text it received. The `edit`
helpers take syntax nodes and start at the node's first token, after any leading
comments.

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

			return bindings.elements.flatMap((element) => {
				if ((element.propertyName ?? element.name).text !== payload.from) return [];

				return element.propertyName === undefined
					? [edit.replace(element, `${payload.to} as ${element.name.text}`)]
					: [edit.replace(element.propertyName, payload.to)];
			});
		}),
	{ include: ({ include }) => include },
);
```

The transform also receives `path`, `project`, `program`, `checker`, `signal`, and
the `services` it declares. `TypeScript.File.effect` takes an Effect transform
instead, which keeps its own error and service types.

## Edit a whole project

`TypeScript.Project.promise` runs a transform once per compiler project and
passes it that project's matched files. `references(symbol)` runs the compiler's
find-references and returns the uses in those files. With it, a transform can
rename a field everywhere a value of its type flows, whatever the variables are
called.

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

Each edit carries the root-relative path of its file, and an edit to a file
outside the project's matched files fails the action. `edit.rename` keeps the local
name in shorthand forms, so `const { a1 } = value` becomes
`const { a2: a1 } = value`. It throws for name positions it does not support.

Files outside every tsconfig file form an inferred project. `project.kind` tells
the transform which kind it has.

## Run the handlers

These are ordinary deltafold handlers, so a plan can mix them with
`Handler.promise` and `Handler.effect` handlers. They require
`TypeScript.Workspace`:

```ts
import { TypeScriptNode } from "@deltafold/typescript/node";
import { Executor } from "deltafold";

await Executor.runPromise(plan, {
	handlers: [renameImports, renameField],
	services: TypeScriptNode.layer({ root: process.cwd() }),
});
```

Payload globs are relative to `root`. Run a tool's migration once at the
repository root, and a library's migration once in each package that uses the
library.

## Files, locks, and writes

- Globs never match inside `node_modules`. Transforms can still read installed
  type declarations through the compiler, but they edit only your files.
- The handler refuses absolute patterns and patterns with a `..` segment, even
  inside braces. It also refuses symbolic links and junctions, and never matches a
  file outside the root.
- A handler locks every matched file before reading it and keeps the locks until
  its action ends. A custom handler can take the same locks with
  `workspace.lock(paths)`.
- Offsets are UTF-16 positions in the text without its byte order mark. All edits
  for a file refer to the text the transform received. The handler refuses
  overlapping edits and applies identical replacements once.
- The handler keeps the byte order mark and line endings. Edited JSON must still
  parse in the original's dialect.
- The handler writes a temporary file for each changed file, checks that no
  original changed since it was read, and then renames each temporary file over
  its original. It rolls nothing back.

## Errors

| Error             | Meaning                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TransformFailed` | At least one transform failed, and no file was written. `failures` lists each failure with its `project`, `path`, and `cause`. |
| `WriteFailed`     | Writing failed. It lists the written, failed, and pending paths. A file found changed since it was read fails here.            |
| `ReadFailed`      | A pattern, a link, or a file could not be read before any transform ran.                                                       |
| `CompilerFailed`  | The TypeScript compiler failed to start or crashed.                                                                            |

A failure's `path` names the file when the failure concerns one: a file with
syntax errors, a failed file transform, or edits the handler refused for that file.
A project transform's own error, or an edit it returns for a file outside its
project, has no `path`.

A cause is one of these:

- an error the transform declared with `errors`
- `Handler.UnexpectedHandlerError` from deltafold, for any other error
- `SyntaxErrors`, for a matched file that does not parse
- `EditRejected`, for edits the handler refuses

`TypeScript.causes(error, guard)` returns the failures whose cause a guard
recognizes.

## What find-references misses

`references` uses TypeScript's own find-references, which misses some uses of a
property. Editors that rename through TypeScript miss the same ones.

Two of them change behavior without a compiler error, so check for them in your
transform or by hand:

- An object literal without a declared type that spreads a value and sets the old
  key, such as `{ ...value, a1: 2 }`. After the rename it adds a field instead of
  overriding one.
- Values typed `any`, such as `anyValue.a1`.

The compiler reports the others as errors after the rename:

- String literals typed as `keyof A`, such as `const key: keyof A = "a1"`.
- Generic code constrained by shape, such as `<T extends { a1: number }>`.
