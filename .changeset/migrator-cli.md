---
"deltafold": minor
"@deltafold/cli": minor
---

Add `deltafold/cli` for shipping a package's own migrator command. `Command.make` builds `validate`, `plan`, `upgrades`, `downgrades`, `guide`, `migrate`, and `changelog` commands from a package declaration and its handlers, as an `effect/cli` command that `Cli.run` runs as a program or that mounts under another command. Results go to stdout, `--json` prints versioned documents, and exit statuses distinguish failures, caller input, and interruption. `migrate` forwards package observers, prints progress, and asks a person at a terminal to confirm manual handlers; without a terminal it refuses to start runs with manual work. Add `@deltafold/cli`, which ships the `deltafold` command for deltafold's own history.
