# Contributing to deltafold

deltafold is in early development. The [requirements](notes/requirements.md)
and [decisions](notes/decisions.md) describe what the library must do and why.
Open an issue before starting a large change, so the design can be discussed
first.

## Requirements

- Node.js: a version in the `engines.node` range of the root
  [package.json](package.json). [.node-version](.node-version) selects the
  default.
- pnpm: the version in the `packageManager` field of the root package.json. On
  Windows, an older global pnpm may fail to switch to it automatically. Install
  that version, or run it with `npx pnpm@<version>`.

## Setup

```sh
pnpm install
```

### Agent skills

Project agent skills come from [skills.sh](https://skills.sh). Restore them with
`npx skills experimental_install`, and update them with `npx skills update -p`.

## Checks

Run `pnpm run check` before you push. It runs the format check and lint, then
typecheck, build, and test. `pnpm run format` rewrites files to fix formatting.
The `scripts` field of the root [package.json](package.json) lists the
individual checks.

Lint uses Effect's Oxlint integration. For editor setup and diagnostics,
see the [Effect language service documentation](https://github.com/Effect-TS/tsgo#readme).

CI runs the same scripts on Ubuntu and Windows, and builds and tests on the
minimum and newest supported Node.js lines.

## Changesets

Add a changeset for every change that affects package consumers:

```sh
pnpm run changeset
```

Changes that only touch tooling, tests, or notes do not need one. Maintainers
apply changesets with `pnpm run version`. No automated release is
configured.

## Branches and merging

- `main` changes only through pull requests. Direct pushes, force pushes, and
  branch deletion are blocked.
- A pull request merges only when all CI checks pass on a branch that is up to
  date with `main` and every review conversation is resolved. It also needs one
  approval from a code owner, given after the last push.
- Pull requests are squash-merged, so `main` keeps a linear history. Merged
  branches are deleted automatically.

## Pull requests

- Keep each pull request focused, and fill in the template.
- Keep repository content public-safe. Do not commit credentials, private
  conversation or session links, absolute machine paths, or personal contact
  details. Use an author email you are willing to publish, such as your GitHub
  noreply address.

## Security issues

Do not report vulnerabilities in public issues. Follow the
[security policy](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
