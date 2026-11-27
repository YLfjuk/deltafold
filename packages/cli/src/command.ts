import * as EffectCli from "effect/cli";

import { Command } from "deltafold/cli";
import { deltafold } from "deltafold/delta";
import manifest from "../package.json" with { type: "json" };
import * as PackageConfig from "./configs/package.ts";

// The command is named after the bin that vite.config.ts declares.
const [name = PackageConfig.name] = Object.keys(manifest.bin);

// deltafold's own migrator is the `self` subcommand, so the top level stays free for
// commands that work on the user's repository.
export const root = EffectCli.Command.make(name).pipe(
	EffectCli.Command.withDescription("The deltafold command line"),
	EffectCli.Command.withSubcommands([
		Command.make(deltafold, {
			name: "self",
			description: "Plan and run migrations between versions of the deltafold library",
		}),
	]),
);
