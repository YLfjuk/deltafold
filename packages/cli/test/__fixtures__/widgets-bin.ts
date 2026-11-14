import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { Cli, Command } from "deltafold/cli";
import { widgets } from "./widgets.ts";

const command = Command.make(widgets, {
	name: "widgets",
	handlers: () => import("./widgets.ts").then((module) => module.handlers),
});

Cli.run(command, { version: "3.0.0" }).pipe(
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
