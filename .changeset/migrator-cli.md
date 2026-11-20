---
"deltafold": minor
"@deltafold/cli": minor
---

Add `deltafold/cli` for shipping a package's own migrator command. `Command.make` builds `validate`, `plan`, `upgrades`, `downgrades`, `guide`, `migrate`, and `changelog` commands from a package declaration and its handlers, as an `effect/cli` command that `Cli.run` runs as a program or that mounts under another command; `Cli.Json` and `Cli.NoColor` are the shared `--json` and `--no-color` settings a root installs once. Results go to stdout, `--json` prints versioned documents, and exit statuses distinguish failures, caller input, and interruption. `migrate` passes the observers supplied beside its handlers to the executor, prints progress, and asks a person at a terminal to confirm manual handlers; without a terminal it refuses to start runs with manual work. Add `@deltafold/cli`, which ships the `deltafold` command for deltafold's own history.
