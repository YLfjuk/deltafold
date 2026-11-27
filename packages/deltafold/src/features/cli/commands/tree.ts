import { Command } from "effect/cli";

import { changelogCommand } from "./changelog.ts";
import type { Definition } from "./definition.ts";
import { destinationsCommand } from "./destinations.ts";
import { guideCommand } from "./guide.ts";
import { migrateCommand } from "./migrate.ts";
import { planCommand } from "./plan.ts";
import { validateCommand } from "./validate.ts";

/** Builds the command tree for a package. */
export const commands = (definition: Definition) => {
	const { handlers, releases } = definition;

	return Command.make(definition.name).pipe(
		Command.withDescription(definition.description),
		Command.withSubcommands([
			validateCommand(definition),
			planCommand(definition),
			destinationsCommand(definition, "upgrade"),
			destinationsCommand(definition, "downgrade"),
			...(handlers === undefined ? [] : [migrateCommand(definition, handlers)]),
			guideCommand(definition),
			...(releases === undefined ? [] : [changelogCommand(definition, releases)]),
		]),
	);
};
