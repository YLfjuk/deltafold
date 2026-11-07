import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Effect, Schema } from "effect";

import { Action, Handler } from "deltafold";

const RenameKey = Action.define<{ target: string; from: string; to: string }>("config.rename", {
	describe: ({ target, from, to }) => `In ${target}, rename "${from}" to "${to}"`,
});
const renameA = RenameKey.make("rename-a", { target: "a", from: "timeout", to: "requestTimeout" });

const ConfigEditor = Context.Service<{
	readonly update: (target: string, signal: AbortSignal) => Promise<void>;
}>("test/ConfigEditor");

class NotFound extends Error {
	readonly _tag = "NotFound";
}
const Conflict = Schema.TaggedStruct("Conflict", { key: Schema.String });

describe("Handler typing", () => {
	it("infers payloads, services, and declared errors for Promise handlers", () => {
		const handler = Handler.promise(
			renameA,
			async (payload, { signal, editor }) => {
				expectTypeOf(payload).toEqualTypeOf<{ target: string; from: string; to: string }>();
				expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
				await editor.update(payload.target, signal);
			},
			{
				services: { editor: ConfigEditor },
				errors: [
					(cause: unknown): cause is NotFound => cause instanceof NotFound,
					Conflict,
				],
				when: async (payload, { editor }) => {
					expectTypeOf(editor).toEqualTypeOf<
						Context.Service.Shape<typeof ConfigEditor>
					>();
					return payload.target === "a";
				},
			},
		);

		expectTypeOf(handler.action).toEqualTypeOf(renameA);
		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<
			Context.Service.Identifier<typeof ConfigEditor>
		>();
		expectTypeOf<Handler.Error<typeof handler>>().toEqualTypeOf<
			NotFound | typeof Conflict.Type | Handler.UnexpectedHandlerError
		>();
	});

	it("accepts inferred type predicates as error guards", () => {
		const handler = Handler.promise(renameA, async () => {}, {
			errors: [(cause: unknown) => cause instanceof NotFound],
		});

		expectTypeOf<Handler.Error<typeof handler>>().toEqualTypeOf<
			NotFound | Handler.UnexpectedHandlerError
		>();
	});

	it("keeps registrations without options free of requirements", () => {
		const handler = Handler.promise(renameA, async () => {});

		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<never>();
		expectTypeOf<
			Handler.Error<typeof handler>
		>().toEqualTypeOf<Handler.UnexpectedHandlerError>();
	});

	it("keeps native Effect errors and services", () => {
		class EditFailed extends Schema.TaggedError<EditFailed>()("EditFailed", {}) {}
		const handler = Handler.effect(
			renameA,
			(payload) =>
				Effect.gen(function* () {
					const editor = yield* ConfigEditor;
					yield* Effect.promise(() =>
						editor.update(payload.target, new AbortController().signal),
					);
					return yield* new EditFailed();
				}),
			{ when: (payload) => Effect.succeed(payload.from === "timeout") },
		);

		expectTypeOf<Handler.Error<typeof handler>>().toEqualTypeOf<EditFailed>();
		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<
			Context.Service.Identifier<typeof ConfigEditor>
		>();
	});

	it("rejects invalid handler declarations", () => {
		expect.assertions(0);

		Handler.promise(
			renameA,
			// @ts-expect-error the payload has no `missing` property.
			async (payload) => payload.missing,
		);

		Handler.promise(renameA, async () => {}, {
			// @ts-expect-error `signal` is reserved for the AbortSignal.
			services: { signal: ConfigEditor },
		});

		Handler.promise(renameA, async () => {}, {
			// @ts-expect-error error guards must be type predicates.
			errors: [(_cause: unknown) => true],
		});

		// @ts-expect-error Promise handlers return a Promise.
		Handler.promise(renameA, () => undefined);

		// @ts-expect-error Effect preconditions return an Effect of a boolean.
		Handler.effect(renameA, () => Effect.void, { when: () => Effect.succeed("yes") });

		Handler.promise(renameA, async (_payload, context) => {
			// @ts-expect-error services that were not declared are absent from the context.
			void context.editor;
		});
	});
});
