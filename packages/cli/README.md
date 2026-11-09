# @deltafold/cli

The `deltafold` command plans and runs migrations between versions of
deltafold itself. It is built with
[`deltafold/cli`](https://github.com/YLfjuk/deltafold/tree/main/packages/deltafold#ship-a-migrator-command),
the same toolkit that package authors use to ship a migrator command for their
own packages.

deltafold is in early development, and its history has no migrations yet. The
command validates and inspects that history; `migrate` is added once a release
declares migrations and handlers.

## Usage

```sh
npx @deltafold/cli --help
npx @deltafold/cli validate
npx @deltafold/cli upgrades --from 0.0.0 --json
```

The command requires Node.js 22.18 or later. Output streams, `--json`
documents, and exit statuses follow the
[`deltafold/cli` conventions](https://github.com/YLfjuk/deltafold/tree/main/packages/deltafold#ship-a-migrator-command).
Press Ctrl+C once to cancel a run and wait for running actions to stop, or
twice to exit at once.

## License

[MIT](https://github.com/YLfjuk/deltafold/blob/main/LICENSE)
