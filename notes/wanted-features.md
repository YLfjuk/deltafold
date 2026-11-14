# Wanted features

These are design intentions, not implemented APIs or commitments to a release.

## Custom delta files with TypeScript content mappers

Status: wanted; deferred until the basic release flow and authoring model settle.

Support custom authoring files such as `.change.delta` and `.version.delta` to
reduce object-construction boilerplate. Provide TypeScript diagnostics,
completion, and navigation through a TypeScript 7.1 content mapper. Ordinary
TypeScript declarations remain a supported authoring path.

Filename-derived IDs are desired. Define collision namespaces, explicit ID
overrides, and rename behavior before implementation; a filename change must not
silently rewrite historical identity.

Use one parsing/model-construction contract across the release loader, mapper,
and any build/runtime integration. A compiler/editor mapping alone does not
establish runtime or bundler support. Keep this optional and outside core.

Acceptance goals:

- Custom input and equivalent TypeScript input produce the same models.
- Diagnostics point to the original custom file rather than generated code.
- Consumer-defined metadata retains useful type checking.
- Command-line checking and editor tooling agree on the custom format.
- Pending inputs can be snapshotted and consumed by the release flow without
  requiring the mapper at runtime for generated ordinary TypeScript output.
- Document compiler version support, external-code permission, workspace trust,
  loading/build requirements, and compatibility with Effect tooling.

Still open: grammar, package name, extension registration for compound suffixes,
metadata/type declarations, generated output format, and distribution.

References:

- [TypeScript 7.1 content mappers](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/#content-mappers)
- [Content mapper protocol](https://github.com/microsoft/typescript-go/pull/4712)

## TypeScript 7.1 API for release tooling

Status: candidate implementation tool, not a required dependency decision.

Evaluate syntax factories for version-file generation and filesystem snapshots
for checking proposed generated code before apply. Semantic analysis may help
explicit TypeScript-aware replacement adapters. Keep literal file replacements
and data-only planning independent of a compiler when they do not need one.

Do not assume semantic analysis can evaluate arbitrary metadata or recover the
source declaration of an arbitrary runtime object. Manage compiler API,
program, and snapshot lifetimes explicitly. Verify supported TypeScript and
Effect compiler versions before adoption.

Reference: [TypeScript 7.1 API](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/#typescript-7.1-api).

## Version formats beyond SemVer

Status: wanted; deferred until usage provides concrete ecosystem requirements.

Initially, all built-in and custom VersionStrategy implementations produce valid
SemVer versions. Custom strategies may use different calculation rules; they are
not required to use the built-in bump algorithm.

Future calendar versions or arbitrary labels may require explicit contracts for
validation, canonical identity, serialization, and optional capabilities such as
ordering or dependency ranges. Do not generalize these contracts in advance.
A later breaking API change is acceptable when supported by real usage.
