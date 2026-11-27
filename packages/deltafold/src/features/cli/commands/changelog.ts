import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import type { Release } from "../../../foundation/version.ts";
import * as Encode from "../encode.ts";
import { fail } from "../failure.ts";
import type { Definition } from "./definition.ts";
import { emitDocument, renderDocument } from "./document.ts";
import { formatFlag, outputFlag } from "./flags.ts";
import { examples, programOf, withOutput } from "./program.ts";

export const changelogCommand = (
	definition: Definition,
	releases: () => ReadonlyArray<Release<any>>,
) =>
	Command.make(
		"changelog",
		{
			release: Flag.String("release").pipe(
				Flag.withMetavar("VERSION"),
				Flag.withDescription("Render only this release"),
				Flag.optional,
			),
			format: formatFlag,
			output: outputFlag,
		},
		(input, commandPath?: ReadonlyArray<string>) =>
			withOutput(programOf(definition, commandPath))(
				Effect.gen(function* () {
					const pkg = definition.package;
					const kind = Option.isSome(input.release) ? "release" : "history";
					const all = yield* Effect.try({ try: releases, catch: Encode.error }).pipe(
						Effect.catch((error) =>
							fail({
								reason: "invalid_release_metadata",
								message: "Couldn't load the release metadata",
								status: "error",
								exitCode: 1,
								details: [error.message],
								data: { error },
							}),
						),
					);
					const document = yield* Effect.try({
						try: () => {
							if (Option.isNone(input.release))
								return definition.changelog.history(pkg, { releases: all });
							const id = input.release.value;
							const release = all.find((entry) => entry.version.id === id);

							return release === undefined
								? undefined
								: definition.changelog.release(pkg, release);
						},
						catch: Encode.error,
					}).pipe(
						Effect.catch((error) =>
							fail({
								reason: "invalid_release_metadata",
								message: error.message,
								status: "error",
								exitCode: 1,
							}),
						),
					);
					if (document === undefined) {
						const known = all.map((entry) => entry.version.id);

						return yield* fail({
							reason: "unknown_version",
							message: `No release metadata for version "${Option.getOrElse(input.release, () => "")}"`,
							status: "error",
							exitCode: 2,
							details: [`Releases: ${known.join(", ") || "none"}`],
							data: { version: Option.getOrNull(input.release), known },
						});
					}
					const content = yield* renderDocument(document, input.format);

					return yield* emitDocument(
						definition,
						kind,
						content,
						input.format,
						input.output,
					);
				}),
			),
	).pipe(
		Command.withDescription("Render the release history, or one release"),
		Command.withExamples(
			examples([
				{ args: "", description: "Print the history as Markdown" },
				{ args: "--release 2.0.0", description: "Print one release" },
			]),
		),
	);
