# @deltafold/cli

The `deltafold` command line. `deltafold self` plans and runs migrations
between versions of the deltafold library. It is built with
[`deltafold/cli`](https://www.npmjs.com/package/deltafold),
the same toolkit that package authors use to ship a migrator command for their
own packages.

deltafold is in early development, and its history has no migrations yet.
`deltafold self` validates and inspects that history; `migrate` is added once a
release declares migrations and handlers.

## Usage

```sh
npx @deltafold/cli self --help
npx @deltafold/cli self validate
npx @deltafold/cli self upgrades --from 0.0.0 --json
```

## License

[MIT](https://github.com/YLfjuk/deltafold/blob/main/LICENSE)
