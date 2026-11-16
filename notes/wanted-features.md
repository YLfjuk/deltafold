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

## Ecosystem support beyond SemVer

Status: wanted; deferred until usage provides concrete ecosystem requirements.

Custom version formats are available: a `VersionScheme` gives decoding, encoding,
and ordering, and a strategy built on it plans end to end. The built-in strategy
and dependency handling remain SemVer and npm specific.

Still wanted: built-in schemes and strategies for other ecosystems, such as
calendar versions, and dependency-range policies for schemes other than SemVer.
Do not generalize these in advance. A later breaking API change is acceptable
when supported by real usage.

## Release CLI init

Status: wanted; part of the release CLI, after plan and apply.

`deltafold release init` writes a release config for the workspace. A later
`init --from changesets` or `init --from nx` reads an existing Changesets or Nx
release setup and writes the equivalent group, packages, and policies.

## Manifest adapters

Status: wanted; deferred until a second ecosystem needs it.

`Files.manifest` is a path, read and written as npm `package.json`. Adapters such
as `NpmManifest.at(path)` or `CargoManifest.at(path)` could replace the path and
own reading the version, reading dependency ranges, and editing both.

## Workspace-root path prefix

Status: wanted.

A `<root>/` prefix would let configuration name a workspace-relative path
regardless of where the release config file lives. Today relative paths resolve
against the config file's directory.

## Lockfile updates

Status: wanted; opt-in.

After apply, a `Lockfile.update` step backed by package-manager adapters could
update the lockfile. Until then, users run the install command themselves after
apply; the release CLI is intended to print it.

## Out of scope: npm dist-tags

Prerelease identifiers are arbitrary SemVer identifiers chosen per plan. npm
dist-tags belong to the publish step, which deltafold release does not perform.
