import { Effect, FileSystem, Option, Result } from "effect";

import type { Document } from "../../documents/document.ts";
import { fail, schemaVersion } from "../failure.ts";
import { Output, stringify } from "../output.ts";
import type { Definition } from "./definition.ts";

export const renderDocument = (document: Document, format: "markdown" | "html") =>
	format === "html"
		? Effect.promise(() => import("../../documents/renderers/html.ts")).pipe(
				Effect.map((module) => module.render(document)),
			)
		: Effect.promise(() => import("../../documents/renderers/markdown.ts")).pipe(
				Effect.map((module) => module.render(document)),
			);

export type DocumentKind = "guide" | "history" | "release";

const printDocument = (
	definition: Definition,
	kind: DocumentKind,
	content: string,
	format: "markdown" | "html",
) =>
	Effect.gen(function* () {
		const output = yield* Output;

		return yield* output.result(
			output.json
				? stringify({
						schemaVersion,
						package: definition.package.name,
						document: { kind, format, content },
					})
				: content.replace(/\n$/, ""),
		);
	});

const writeDocument = (
	definition: Definition,
	kind: DocumentKind,
	content: string,
	format: "markdown" | "html",
	path: string,
) =>
	Effect.gen(function* () {
		const output = yield* Output;
		const fs = yield* FileSystem.FileSystem;
		const written = yield* Effect.result(fs.writeFileString(path, content));
		if (Result.isFailure(written)) {
			return yield* fail({
				reason: "write_failed",
				message: `Couldn't write the ${kind} to ${path}`,
				status: "error",
				exitCode: 1,
				details: [written.failure.message],
				data: { path },
			});
		}

		return yield* output.json
			? output.result(
					stringify({
						schemaVersion,
						package: definition.package.name,
						document: { kind, format, path },
					}),
				)
			: output.diagnostic(`Wrote the ${kind} to ${path}`);
	});

/** Prints a rendered document, or writes it to `--output`. */
export const emitDocument = (
	definition: Definition,
	kind: DocumentKind,
	content: string,
	format: "markdown" | "html",
	path: Option.Option<string>,
) =>
	Option.isNone(path)
		? printDocument(definition, kind, content, format)
		: writeDocument(definition, kind, content, format, path.value);
