#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { Cli, Command } from "deltafold/cli";
import packageJson from "../../../package.json" with { type: "json" };
import { deltafold } from "../../history.ts";

const command = Command.make(deltafold, {
	description: "Plan and run migrations between versions of deltafold",
});

// The first interrupt cancels the run and waits a bounded time for running actions to
// stop. A second interrupt exits at once.
let interrupts = 0;
process.on("SIGINT", () => {
	interrupts += 1;
	if (interrupts > 1) process.exit(130);
});

Cli.run(command, { version: packageJson.version }).pipe(
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
