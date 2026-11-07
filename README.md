# deltafold

deltafold is a planned TypeScript library for modeling version history and
resolving migration instructions between versions. It targets Effect 4.

The repository has a workspace and tooling setup and an empty `deltafold` package
in `packages/deltafold`. No library API or release exists yet.

- [API design](notes/api-design.md): the pre-implementation specification.
- [Review findings](notes/review-findings.md): design review results.
- [Implementation plan](notes/implementation-plan.md): phases and progress.

## Development

Requirements: Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` and pnpm 12. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and changesets, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

Project agent skills are installed with [skills.sh](https://skills.sh) as copies in
`.agents/skills` and `.claude/skills`. `skills-lock.json` records their sources.
Restore them with `npx skills experimental_install`. Update them with
`npx skills update -p`.

## License

[MIT](LICENSE)
