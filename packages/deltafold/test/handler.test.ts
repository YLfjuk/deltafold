import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Effect, Schema, Scope } from "effect";

import { Action, Executor, Handler, History, Migration, Version } from "deltafold";

const RenameKey = Action.define<{ target: string; from: string; to: string }>("config.rename", {
	describe: ({ target, from, to }) => `In ${target}, rename "${from}" to "${to}"`,
});
const renameA = RenameKey.make("rename-a", { target: "a", from: "timeout", to: "requestTimeout" });
const renameB = RenameKey.make("rename-b", { target: "b", from: "timeout", to: "requestTimeout" });
type Payload = { target: string; from: string; to: string };

const ConfigEditor = Context.Service<{
	readonly read: (target: string) => Promise<Record<string, unknown>>;
	readonly update: (target: string, signal: AbortSignal) => Promise<void>;
}>("test/ConfigEditor");
type ConfigEditor = Context.Service.Identifier<typeof ConfigEditor>;

const Locks = Context.Service<{
	readonly lock: (
		target: string,
	) => Effect.Effect<{ readonly token: string }, never, Scope.Scope>;
}>("test/Locks");
type Locks = Context.Service.Identifier<typeof Locks>;

class NotFound extends Error {
	readonly _tag = "NotFound";
}
const Conflict = Schema.TaggedStruct("Conflict", { key: Schema.String });

class ReadFailed extends Schema.TaggedError<ReadFailed, { readonly brand: unique symbol }>()(
	"ReadFailed",
	{},
) {}
class EditFailed extends Schema.TaggedError<EditFailed, { readonly brand: unique symbol }>()(
	"EditFailed",
	{},
) {}

/** A handler-defined prepared value, declared as an interface. */
interface Edit {
	readonly target: string;
	readonly next: Record<string, unknown>;
}

describe("Handler typing", () => {
	it("infers payloads, services, and declared errors for Promise handlers", () => {
		const handler = Handler.promise(
			renameA,
			async (payload, { signal, services: { editor } }) => {
				expectTypeOf(payload).toEqualTypeOf<Payload>();
				expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
				await editor.update(payload.target, signal);
			},
			{
				services: { editor: ConfigEditor },
				errors: [
					(cause: unknown): cause is NotFound => cause instanceof NotFound,
					Conflict,
				],
			},
		);

		expectTypeOf(handler.action).toEqualTypeOf(renameA);
		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<ConfigEditor>();
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
		const handler = Handler.effect(renameA, (payload) =>
			Effect.gen(function* () {
				const editor = yield* ConfigEditor;
				yield* Effect.promise(() =>
					editor.update(payload.target, new AbortController().signal),
				);
				return yield* new EditFailed();
			}),
		);

		expectTypeOf<Handler.Error<typeof handler>>().toEqualTypeOf<EditFailed>();
		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<ConfigEditor>();
	});

	it("keeps services apart from the signal, so any service name works", () => {
		const handler = Handler.promise(
			renameA,
			async (_payload, { signal, services }) => {
				expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
				expectTypeOf(services.signal).toEqualTypeOf<
					Context.Service.Shape<typeof ConfigEditor>
				>();
			},
			{ services: { signal: ConfigEditor } },
		);

		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<ConfigEditor>();
	});
});

describe("Prepared handler typing", () => {
	it("passes the inferred prepared value and both contexts to Promise phases", () => {
		const handler = Handler.promise(
			renameA,
			{
				prepare: async (payload, { signal, services: { editor } }) => {
					expectTypeOf(payload).toEqualTypeOf<Payload>();
					expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
					const config = await editor.read(payload.target);

					return payload.from in config
						? Handler.prepared({ target: payload.target, next: config })
						: Handler.skip(`${payload.target} has no ${payload.from}`);
				},
				apply: async (edit, { payload, signal, services: { editor } }) => {
					expectTypeOf(edit).toEqualTypeOf<{
						target: string;
						next: Record<string, unknown>;
					}>();
					expectTypeOf(payload).toEqualTypeOf<Payload>();
					expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
					await editor.update(edit.target, signal);
				},
			},
			{
				services: { editor: ConfigEditor },
				errors: [(cause: unknown) => cause instanceof NotFound],
			},
		);

		// The prepared value stays inside: the handler has the ordinary handler type.
		expectTypeOf(handler).toEqualTypeOf<
			Handler.Handler<typeof renameA, NotFound | Handler.UnexpectedHandlerError, ConfigEditor>
		>();
	});

	it("infers unions, interfaces, and never as prepared values", () => {
		Handler.promise(renameA, {
			prepare: async (payload) =>
				payload.target === "a"
					? Handler.prepared({ kind: "rename" as const, to: payload.to })
					: Handler.prepared({ kind: "delete" as const }),
			apply: async (prepared) => {
				expectTypeOf(prepared).toEqualTypeOf<
					{ kind: "rename"; to: string } | { kind: "delete" }
				>();
			},
		});

		Handler.promise(renameA, {
			prepare: async (payload): Promise<Handler.Preparation<Edit>> =>
				Handler.prepared({ target: payload.target, next: {} }),
			apply: async (edit) => {
				expectTypeOf(edit).toEqualTypeOf<Edit>();
			},
		});

		Handler.effect(renameA, {
			prepare: () => Effect.succeed(Handler.skip("Never applies")),
			apply: (prepared) => {
				expectTypeOf(prepared).toEqualTypeOf<never>();
				return Effect.void;
			},
		});

		Handler.promise(renameA, {
			prepare: () => Handler.prepared(),
			apply: async (prepared) => {
				expectTypeOf(prepared).toEqualTypeOf<void>();
			},
		});
	});

	it("keeps a prepared value that looks like a skip apart from a skip", () => {
		Handler.promise(renameA, {
			prepare: async () => Handler.prepared({ _tag: "Skip", reason: "data" } as const),
			apply: async (prepared) => {
				expectTypeOf(prepared).toEqualTypeOf<{
					readonly _tag: "Skip";
					readonly reason: "data";
				}>();
			},
		});
	});

	it("unions the errors and services of both Effect phases and removes Scope", () => {
		const handler = Handler.effect(renameA, {
			prepare: (payload) =>
				Effect.gen(function* () {
					const locks = yield* Locks;
					const lock = yield* locks.lock(payload.target);
					if (payload.from === "") return yield* new ReadFailed();

					return Handler.prepared(lock);
				}),
			apply: (lock, { payload }) =>
				Effect.gen(function* () {
					expectTypeOf(lock).toEqualTypeOf<{ readonly token: string }>();
					expectTypeOf(payload).toEqualTypeOf<Payload>();
					const editor = yield* ConfigEditor;
					yield* Effect.promise(() =>
						editor.update(payload.target, new AbortController().signal),
					);
					yield* Effect.addFinalizer(() => Effect.void);

					return yield* new EditFailed();
				}),
		});

		expectTypeOf<Handler.Error<typeof handler>>().toEqualTypeOf<ReadFailed | EditFailed>();
		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<Locks | ConfigEditor>();
	});

	it("removes Scope from Effect handlers without a prepare phase", () => {
		const handler = Handler.effect(renameA, (payload) =>
			Effect.gen(function* () {
				const locks = yield* Locks;
				yield* locks.lock(payload.target);
			}),
		);

		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<Locks>();
	});

	it("keeps executor channels precise across handlers with different prepared values", () => {
		const v1 = Version.make("1.0.0", { changes: [] });
		const v2 = Version.make("2.0.0", { previous: v1, changes: [] });
		const history = History.make({
			versions: [v1, v2],
			migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${renameA}${renameB}`],
		});
		const handlers = [
			Handler.effect(renameA, {
				prepare: () => Effect.succeed(Handler.prepared(1)),
				apply: () => Effect.fail(new EditFailed()),
			}),
			Handler.promise(
				renameB,
				{
					prepare: async () => Handler.prepared("text"),
					apply: async () => {},
				},
				{ services: { editor: ConfigEditor } },
			),
		];
		const plan = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
		if (plan._tag === "Failure") return;
		const execution = Executor.effect(plan.success, { handlers });

		expectTypeOf<Effect.Services<typeof execution>>().toEqualTypeOf<ConfigEditor>();
		expectTypeOf<Executor.Errors<(typeof handlers)[number]>>().toEqualTypeOf<
			EditFailed | Handler.UnexpectedHandlerError
		>();
	});

	it("rejects invalid handler declarations", () => {
		expect.assertions(0);

		Handler.promise(
			renameA,
			// @ts-expect-error the payload has no `missing` property.
			async (payload) => payload.missing,
		);

		// @ts-expect-error error guards must be type predicates.
		Handler.promise(renameA, async () => {}, { errors: [(_cause: unknown) => true] });

		// @ts-expect-error Promise handlers return a Promise.
		Handler.promise(renameA, () => undefined);

		Handler.promise(renameA, async (_payload, context) => {
			// @ts-expect-error services that were not declared are absent from the context.
			void context.services.editor;
		});

		// @ts-expect-error preconditions are prepare phases now.
		Handler.promise(renameA, async () => {}, { when: () => true });

		// @ts-expect-error a prepared handler needs an apply phase.
		Handler.promise(renameA, { prepare: async () => Handler.prepared() });

		// @ts-expect-error a prepared handler needs a prepare phase.
		Handler.effect(renameA, { apply: () => Effect.void });

		Handler.promise(renameA, {
			// @ts-expect-error prepare returns Handler.prepared or Handler.skip, not a value.
			prepare: async () => true,
			apply: async () => {},
		});

		Handler.effect(renameA, {
			// @ts-expect-error prepare succeeds with Handler.prepared or Handler.skip.
			prepare: () => Effect.succeed({ edits: [] }),
			apply: () => Effect.void,
		});

		Handler.promise(renameA, {
			prepare: async () => Handler.prepared({ count: 1 }),
			// @ts-expect-error apply receives the prepared value, not a narrower type.
			apply: async (_prepared: { count: 1; extra: string }) => {},
		});

		// @ts-expect-error Effect handlers take no options.
		Handler.effect(renameA, () => Effect.void, {});
	});
});
