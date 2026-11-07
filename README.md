# deltafold

deltafold is a TypeScript library for modeling version history, resolving
migration instructions between versions, running them with your own handlers,
and generating changelogs and upgrade guides. It is built on Effect 4 and is in
early development.

- [Package README](packages/deltafold/README.md): installation and usage.
- [Requirements](notes/requirements.md): what the library must do, with status.
- [Decisions](notes/decisions.md): design decisions, provisional choices,
  limitations, and open questions.
- [Tooling](notes/tooling.md): how the workspace is set up.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for requirements, setup, checks, and
changesets, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

Project agent skills are installed with [skills.sh](https://skills.sh) as copies in
`.agents/skills` and `.claude/skills`. `skills-lock.json` records their sources.
Restore them with `npx skills experimental_install`. Update them with
`npx skills update -p`.

## License

[MIT](LICENSE)
