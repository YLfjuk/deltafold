// A stand-in for a third-party integration module. It builds handlers with the public
// Handler.promise contract and declares its own service; it is not a codemod engine.
import { Context } from "effect";

import { Handler, type Action } from "deltafold";

export type SourceFiles = {
	readonly list: (include: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;
	readonly rewrite: (file: string, transform: (source: string) => string) => Promise<void>;
};

export const SourceFiles = Context.Service<SourceFiles>("test/SourceFiles");

export class TransformRejected extends Error {
	readonly _tag = "TransformRejected";
	readonly file: string;

	constructor(file: string) {
		super(`Transform rejected ${file}`);
		this.file = file;
	}
}

export const handler = <A extends Action.Any>(
	action: A,
	options: {
		readonly transform: (source: string, payload: A["payload"]) => string;
		readonly include: ReadonlyArray<string>;
	},
) =>
	Handler.promise(
		action,
		async (payload, { files, signal }) => {
			for (const file of await files.list(options.include)) {
				signal.throwIfAborted();
				await files.rewrite(file, (source) => options.transform(source, payload));
			}
		},
		{
			services: { files: SourceFiles },
			errors: [(cause: unknown) => cause instanceof TransformRejected],
			when: async (_payload, { files }) => (await files.list(options.include)).length > 0,
			skipReason: "No files match the include patterns",
		},
	);
