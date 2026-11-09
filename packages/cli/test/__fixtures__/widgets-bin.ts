import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { Cli } from "deltafold/cli";
import { widgets } from "./widgets.ts";

const cli = Cli.make(widgets, {
	name: "widgets",
	version: "3.0.0",
	handlers: () => import("./widgets.ts").then((module) => module.handlers),
});

Cli.run(cli).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
