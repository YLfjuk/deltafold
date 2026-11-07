# deltafold tooling

How the workspace is set up, and what maintainers need to know when changing it.
Contributor setup and scripts are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Adopted toolchain

| Concern                 | Choice                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Package manager         | pnpm 12.18.0 (`packageManager`), workspace `packages/*`                                                                          |
| Task ordering and cache | Turborepo 2.11.10: `build`, `typecheck`, `test`                                                                                  |
| Library packaging       | Vite+ 1.5.0 `vp pack` (tsdown), ESM only, neutral platform, declarations, strict publint, attw (`esm-only` profile, error level) |
| Tests                   | Vite+ `vp test` (Vitest 5.1.0) with `@effect/vitest` 4.1.2                                                                       |
| Lint                    | Vite+ `vp lint` (Oxlint), type-aware with type checking                                                                          |
| Format                  | Vite+ `vp fmt` (Oxfmt), options copied from the shared oxfmt template                                                            |
| Type checking           | TypeScript 7.0.2 `tsc --noEmit`, strict base config                                                                              |
| Effect                  | `effect` 4.1.2; the package declares `effect: ^4.1.2` as a peer dependency                                                       |
| Versioning              | Changesets 3.0.3, public access, base branch `main`                                                                              |
| CI                      | GitHub Actions: full checks on Ubuntu and Windows (Node 24), build and test on Node 22.18.0 and 26                               |
| Agent skills            | skills.sh 1.7.6, project scope, copied into `.agents/skills` and `.claude/skills`, sources in `skills-lock.json`                 |

Installed agent skills: abstraction-boundaries, codebase-structure, deslop,
documentation, orwell-clear-writing, ponytail, react-conventions,
typescript-conventions, and unslop. They are copies rather than symlinks, so they
check out correctly where Git does not create symlinks. Oxfmt ignores them.

Repository files:

- `.github/CODEOWNERS` assigns every path to @YLfjuk.
- `.github/pull_request_template.md` covers validation, whether a changeset applies,
  and a public-content check.
- Bug and feature issue forms apply the existing `bug` and `enhancement` labels.
  Blank issues stay enabled, and a contact link points to the security policy.
- `CONTRIBUTING.md` covers requirements, setup, scripts, changesets, and
  pull-request expectations. `SECURITY.md` asks for reports through GitHub
  private vulnerability reporting, with no promised response time.
- `.github/dependabot.yml` checks GitHub Actions and the pnpm workspace weekly,
  with the `dependencies` label. Actions updates are grouped together. Effect
  packages share one group, and other minor and patch updates share another.
  Version updates wait 7 days after release. `vite-plus` is excluded because its
  `vite` and `vitest` overrides in `pnpm-workspace.yaml` must change with it.
- The CI workflow keeps read-only `contents` permission and uses no
  `pull_request_target` trigger. Its check job fails if install, build, or tests
  change a tracked file or leave a file that is not ignored.
- Rulesets, labels, and security settings are configured on GitHub, outside this
  repository. `CONTRIBUTING.md` summarizes the branch policy: changes reach `main`
  only through pull requests, which need passing CI on an up-to-date branch,
  resolved conversations, and a code-owner approval, and merges are squash-only.
  Private vulnerability reporting and the `dependencies` label are enabled.

Node requirement for development and CI: `^22.18.0 || ^24.11.0 || >=26.0.0`, the
range required by Vite+, Vitest 5, and tsdown. `.node-version` selects Node 24.
The library targets ES2022 without Node types, and its own runtime support
policy is still to be decided before the first release.

Layout and conventions:

- `tsconfig.base.json` defines the `@deltafold/dev.src` condition and the strict
  compiler options. The package `vite.config.ts` reads that condition and passes
  it to `pack.exports.devExports`, which matches the shared tsdown template.
  During development, `exports` resolve to `src`; `publishConfig.exports` point
  at `dist`.
- The root `vite.config.ts` holds the lint and format settings that Vite+ applies
  across the workspace. `lint` and `format:check` run as root scripts. Package
  tasks run through Turborepo.
- `vite-plus` is the only test, lint, format, and packaging dependency. No direct
  `vitest`, `vite`, `oxlint`, `oxfmt`, or `tsdown` dependency is declared.
- Each package declares the dependencies that its own files, scripts, and
  configuration use: `vite-plus`, `typescript`, `effect`, `@effect/vitest`,
  `publint`, and `@arethetypeswrong/core`. The root declares only workspace tools:
  `turbo`, `@changesets/cli`, `vite-plus` for root lint and format, and
  `typescript`. Vite+'s bundled tsdown loads publint and attw as optional peers
  of `vite-plus`. pnpm links them only when the package that depends on
  `vite-plus` also declares them; otherwise they resolve through pnpm's hidden
  hoisting.
- The default pnpm catalog in `pnpm-workspace.yaml` holds the shared versions.
  Every devDependency uses `catalog:`. The catalog stays in `pnpm-workspace.yaml`
  because Dependabot does not read catalogs split into other files. The catalog's
  `effect` entry is the range `^4.1.2`, which serves as both the development
  version and the published peer range. Dependabot uses `increase-if-necessary`,
  so updates within that range change only the lockfile.
- `exactOptionalPropertyTypes` is not in the shared base. A package can enable it
  when its API distinguishes a missing property from an explicit `undefined`.
- `allowImportingTsExtensions` allows relative `.ts` imports. Only tsdown emits
  files. `declaration` and `declarationMap` are on, so tsdown writes the `.d.ts.map`
  that the bundled declarations reference. Type checking emits nothing.
- The package publishes `dist` and `src`, so the JavaScript and declaration source
  maps resolve. Published `exports` come from `publishConfig.exports` and do not
  include the development condition.
- Package metadata includes keywords, homepage, bugs, author, and a package
  README.
- Package entry points are listed in `pack.entry`. The packer generates matching
  `exports` and `publishConfig.exports` entries in `package.json`.
- The package compiles with `lib: ES2022` and no DOM or Node types.
  `types/abort-signal.d.ts` declares the parts of `AbortSignal` that the package
  uses; it merges with the full declarations in consumer projects and is not
  published. Without it, Effect's `AbortSignal` parameter silently becomes an
  error type.
- Lint requires non-mutating array helpers, which ES2022 lacks. Source code uses
  Effect's `Array` and `Order` modules instead.
- Effect data types use `_tag` discriminants, so the lint configuration allows
  that name in `no-underscore-dangle`.
- Runtime dependencies use `catalog:` entries too.
- No release workflow, npm token, or publish step is configured. The 0.0.0
  placeholder was published manually. `pnpm run changeset` records changes, and
  `pnpm run version` applies them.

## Vite+ trial findings

- Vite+ needs pnpm overrides that alias `vite` to `@voidzero-dev/vite-plus-core`
  and pin `vitest`. The alias version is outside the `vite` peer range of
  Vitest, so `peerDependencyRules.allowedVersions` accepts it.
- Vite+ reads tsdown settings from the `pack` block, so the shared tsdown template
  logic lives in the package `vite.config.ts` rather than in `tsdown.config.ts`.
- Top-level `resolve.conditions` does not reach the Vitest server environment.
  `ssr.resolve.conditions` must also list the development condition, along with
  Vite's default server conditions. Without it, tests resolved `dist`, or failed
  when `dist` was absent.
- tsdown emits declarations with TypeScript 7 but warns that its API is
  experimental. If declaration output regresses, fall back to TypeScript 6 for
  declaration emit.
- Oxlint's Vitest plugin does not recognize `@effect/vitest` test blocks until
  they are listed in `vitest/no-standalone-expect`.
- Oxfmt formats code blocks inside Markdown, including the notes.
- `vp test` and `vp lint` print a note that built-in commands take precedence
  over scripts of the same name. The note is harmless.
- `changeset init` in Changesets 3 is interactive, so its default configuration
  was written by hand. Changesets' own formatting is off (`format: false`), so
  there is one formatter configuration, the Vite+ `fmt` block.
- pnpm 12 ships as a native binary. An older global pnpm 10 failed to switch to
  the pinned version on Windows. Upgrading pnpm, or running `npx pnpm@12.18.0`,
  works around it.
- Publishing must go through pnpm, which applies `publishConfig.exports`.
- With `sourcemap: true` and declaration maps off, the bundled `.d.ts` still ends
  with a `sourceMappingURL` comment, but no map is written. Turning on
  `declarationMap` produces the map.
- In CI, pnpm 12 fails the install when a dependency's build script was not
  approved. Locally it only warns. Removing a package can leave its optional
  peers (for example `tsx`, which pulls in `esbuild`) resolved in the lockfile, so
  check the lockfile diff after removing dependencies.

## Changelogs and releases

- Changesets keeps its default formatter, `@changesets/cli/changelog`.
  `pnpm run version` writes `packages/deltafold/CHANGELOG.md`, as a trial
  confirmed. Entries are plain lines with a commit hash.
- GitHub Releases are wanted but not configured. They need a release workflow,
  for example Changesets' GitHub Action, with write permissions and a decision
  about npm publishing.
- Long term, deltafold should generate its own changelog. Changesets' changelog
  plugin interface (`getReleaseLine`, `getDependencyReleaseLine`) formats one
  line per changeset. Changesets itself writes the `## <version>` and
  `## Major/Minor/Patch Changes` headings and prepends the entry to
  `CHANGELOG.md`. A plugin therefore cannot express deltafold sections or
  resolved migration guides. The likely integration sets `"changelog": false`,
  which Changesets supports, and lets a deltafold step render `CHANGELOG.md`
  from the package history. Release metadata from the release plan arrives as
  `Version.withMetadata` annotations, so a release-tool adapter produces the same
  public annotations as hand-written ones. The `deltafold/changelog` entry point
  now provides the rendering side; the adapter itself is not written.

## Deferred: TSDoc examples and generated API docs

`@effect/docgen` is wanted eventually but is not required for the package, so it
is deferred. A trial with version 4.1.2 found the following:

- It copies each `@example` into `docs/examples`, type-checks the copies with the
  project's `tsc` (TypeScript 7 worked), and writes Markdown API docs.
- With `runExamples`, it also runs each example with `tsx`, and failed
  assertions fail the run. Its convention is `node:assert`, which needs
  `@types/node` in the examples' compiler options. Type-check only avoids `tsx`
  and `@types/node` and keeps examples platform-neutral. Vitest still covers
  behavior.
- Requirements: a `homepage` field (present), `@since` on every export by
  default (exports carry `@since @next` until the first release version is
  known), Node `>=22.19.0` (one patch above the current minimum), and an
  allowance for its `typescript` peer range (`<7`). It calls the `tsc` binary
  and does not import TypeScript.
- Still open: whether generated docs are committed or only produced in CI.
