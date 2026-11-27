#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { Cli } from "deltafold/cli";
import { root } from "../../command.ts";
import * as PackageConfig from "../../configs/package.ts";

// The first interrupt cancels the run and waits a bounded time for running actions to
// stop. A second interrupt exits at once.
let interrupts = 0;
process.on("SIGINT", () => {
	interrupts += 1;
	if (interrupts > 1) process.exit(130);
});

Cli.run(root, { version: PackageConfig.version }).pipe(
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
