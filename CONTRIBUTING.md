# Contributing to deltafold

deltafold is in early development. The design notes in [notes](notes) describe the
planned API. Open an issue before starting a large change, so the design can be
discussed first.

## Requirements

- Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`. `.node-version` selects Node 24.
- pnpm 12. The `packageManager` field in `package.json` pins the exact version.
  On Windows, an older global pnpm may fail to switch to it automatically;
  install pnpm 12 or run `npx pnpm@12.18.0` instead.

## Setup

```sh
pnpm install
```

## Checks

| Command                 | What it runs                                               |
| ----------------------- | ---------------------------------------------------------- |
| `pnpm run check`        | Format check and lint, then typecheck, build, and test     |
| `pnpm run format:check` | `vp fmt --check` (Oxfmt)                                   |
| `pnpm run format`       | `vp fmt`, rewriting files                                  |
| `pnpm run lint`         | `vp lint` (Oxlint with type-aware rules and type checking) |
| `pnpm run typecheck`    | `tsc --noEmit` in each package, through Turborepo          |
| `pnpm run build`        | `vp pack` in each package, through Turborepo               |
| `pnpm run test`         | `vp test run` in each package, through Turborepo           |

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

## Pull requests

- Keep each pull request focused, and fill in the template.
- Run `pnpm run check` before you push.
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
