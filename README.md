# deltafold

deltafold is a planned TypeScript library for modeling version history,
resolving migration instructions between versions, and generating changelogs.

The repository has a workspace and tooling setup and an empty `deltafold` package
in `packages/deltafold`. No library API exists yet. Version 0.0.0 on npm is a placeholder that
reserves the package name.

- [API design](notes/api-design.md): the pre-implementation specification.
- [Review findings](notes/review-findings.md): design review results.
- [Implementation plan](notes/implementation-plan.md): phases and progress.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for requirements, setup, checks, and
changesets, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

Project agent skills are installed with [skills.sh](https://skills.sh) as copies in
`.agents/skills` and `.claude/skills`. `skills-lock.json` records their sources.
Restore them with `npx skills experimental_install`. Update them with
`npx skills update -p`.

## License

[MIT](LICENSE)
