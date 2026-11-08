import { describe, expect, expectTypeOf, it, vi } from "@effect/vitest";
import { Context, Duration, Effect, Fiber, Layer, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Action, Executor, Handler, History, Migration, Plan, Rule, Version } from "deltafold";
import * as Codemod from "./__fixtures__/codemod.ts";
import { RenameKey } from "./__fixtures__/config.ts";

const ConfigEditor = Context.Service<{ readonly update: (target: string) => Promise<void> }>(
	"test/ConfigEditor",
);
type ConfigEditor = Context.Service.Identifier<typeof ConfigEditor>;

const ExportEditor = Context.Service<{
	readonly renameKey: (from: string, to: string) => Effect.Effect<void>;
}>("test/ExportEditor");
type ExportEditor = Context.Service.Identifier<typeof ExportEditor>;

class EditFailed extends Schema.TaggedError<EditFailed>()("EditFailed", {}) {}

const v1 = Version.make("1.0.0", { changes: [] });
const v2 = Version.make("2.0.0", { previous: v1, changes: [] });
const renameJson = RenameKey.make("rename-json", { target: "config.json", from: "a", to: "b" });
const renameExport = RenameKey.make("rename-export", { target: "export-b", from: "a", to: "b" });
const renameSource = RenameKey.make("rename-source", { target: "src", from: "a", to: "b" });
const configHistory = History.make({
	versions: [v1, v2],
	migrations: [
		Migration.make("1-to-2", { from: v1, to: v2 })`
			${renameJson}
			${renameExport}
			${renameSource}
		`,
	],
});

const typeOnly = (_check: () => void) => {};

const resolved = History.resolve(configHistory, { from: "1.0.0", to: "2.0.0" });
if (Result.isFailure(resolved)) throw resolved.failure;
const plan = resolved.success;

// Existing Promise callbacks keep working without refactoring.
const jsonHandler = Handler.promise(
	renameJson,
	async (payload, { editor }) => {
		await editor.update(payload.target);
	},
	{ services: { editor: ConfigEditor } },
);
const exportHandler = Handler.effect(renameExport, (payload) =>
	Effect.gen(function* () {
		const editor = yield* ExportEditor;
		yield* editor.renameKey(payload.from, payload.to);
		if (payload.to === "") yield* new EditFailed();
	}),
);
const sourceHandler = Codemod.handler(renameSource, {
	transform: (source, payload) => source.replaceAll(payload.from, payload.to),
	include: ["src/**/*.ts"],
});

describe("Executor typing", () => {
	it("infers requirements and errors from an ordinary mixed handler array", () => {
		const handlers = [jsonHandler, exportHandler, sourceHandler];
		const execution = Executor.effect(plan, { handlers });

		expectTypeOf<Effect.Services<typeof execution>>().toEqualTypeOf<
			ConfigEditor | ExportEditor | Context.Service.Identifier<typeof Codemod.SourceFiles>
		>();
		type Failure = Executor.Errors<Plan.ActionsOf<typeof plan>, (typeof handlers)[number]>;
		expectTypeOf<Failure>().toEqualTypeOf<
			Handler.UnexpectedHandlerError | EditFailed | Codemod.TransformRejected
		>();
	});

	it("shows statically known missing bindings in the requirements", () => {
		const execution = Executor.effect(plan, { handlers: [jsonHandler] });

		expectTypeOf<Effect.Services<typeof execution>>().toEqualTypeOf<
			ConfigEditor | Handler.Binding<"rename-export"> | Handler.Binding<"rename-source">
		>();
	});

	it("satisfies bindings with Handler.layer and keeps the handlers' own services", () => {
		const bindings = Handler.layer([exportHandler, sourceHandler]);
		expectTypeOf<Layer.Services<typeof bindings>>().toEqualTypeOf<
			ExportEditor | Context.Service.Identifier<typeof Codemod.SourceFiles>
		>();

		const execution = Executor.effect(plan, { handlers: [jsonHandler] }).pipe(
			Effect.provide(bindings),
		);
		expectTypeOf<Effect.Services<typeof execution>>().toEqualTypeOf<
			ConfigEditor | ExportEditor | Context.Service.Identifier<typeof Codemod.SourceFiles>
		>();
		expectTypeOf<Effect.Error<typeof execution>>().toMatchTypeOf<{ readonly _tag: string }>();
	});

	it("checks runtime-coverage plans only at run time", () => {
		const execution = Executor.effect(Plan.withRuntimeCoverage(plan), {
			handlers: [jsonHandler],
		});

		expectTypeOf<Effect.Services<typeof execution>>().toEqualTypeOf<ConfigEditor>();
	});

	it("requires services for Promise execution", () => {
		expect.assertions(0);
		const handlers = [jsonHandler];
		const editor = ConfigEditor.of({ update: async () => {} });

		// Type checks only; the calls never run.
		typeOnly(() => {
			void Executor.runPromise(Plan.withRuntimeCoverage(plan), {
				handlers,
				services: Context.make(ConfigEditor, editor),
			});
			// @ts-expect-error the ConfigEditor service is missing.
			void Executor.runPromise(Plan.withRuntimeCoverage(plan), { handlers });
			void Executor.runPromise(Plan.withRuntimeCoverage(plan), {
				handlers,
				// @ts-expect-error the supplied services do not include ConfigEditor.
				services: Context.make(ExportEditor, { renameKey: () => Effect.void }),
			});
			void Executor.runPromise(plan, {
				handlers,
				// @ts-expect-error bindings for rename-export and rename-source are missing.
				services: Context.make(ConfigEditor, editor),
			});
			void Executor.runPromise(Plan.withRuntimeCoverage(plan), {
				handlers: [Handler.promise(renameJson, async () => {})],
			});
		});
	});
});

const Touch = Action.define<{ readonly name: string }>("test.touch", {
	describe: ({ name }) => `Touch ${name}`,
});
const touch = <const Id extends string>(id: Id) => Touch.make(id, { name: id });

const w1 = Version.make("1.0.0", { changes: [] });
const w2 = Version.make("2.0.0", { previous: w1, changes: [] });
const w3 = Version.make("3.0.0", { previous: w2, changes: [] });

const planOf = <A extends Action.Any>(history: History.History<A>, to = "3.0.0") => {
	const result = History.resolve(history, { from: "1.0.0", to });
	if (Result.isFailure(result)) throw result.failure;

	return result.success;
};

const single = (action: Action.Any) =>
	History.make({
		versions: [w1, w2],
		migrations: [Migration.make("1-to-2", { from: w1, to: w2 })`${action}`],
	});

const outcomes = (report: Executor.Report) =>
	Object.fromEntries(
		report.occurrences.map((entry) => [entry.occurrence.action.id, entry.outcome._tag]),
	);

const recording = (events: Array<string>) => (action: Action.Any) =>
	Handler.effect(action, () => Effect.sync(() => events.push(action.id)));

describe("Executor behavior", () => {
	it.effect("runs mixed Promise, Effect, and module-produced handlers in plan order", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const files = Codemod.SourceFiles.of({
				list: async () => ["src/a.ts"],
				rewrite: async (file, transform) => {
					events.push(`${file}:${transform("a-a")}`);
				},
			});
			const handlers = [jsonHandler, exportHandler, sourceHandler];
			const result = yield* Executor.effect(plan, { handlers }).pipe(
				Effect.provideService(ConfigEditor, {
					update: async (target) => void events.push(target),
				}),
				Effect.provideService(ExportEditor, {
					renameKey: (from, to) => Effect.sync(() => events.push(`${from}->${to}`)),
				}),
				Effect.provideService(Codemod.SourceFiles, files),
			);

			expect(result.status).toBe("completed");
			expect(result.persistence).toBe("none");
			expect(events).toEqual(["config.json", "a->b", "src/a.ts:b-b"]);
			expect(outcomes(result)).toEqual({
				"rename-json": "Completed",
				"rename-export": "Completed",
				"rename-source": "Completed",
			});
		}),
	);

	it.effect("binds different implementations to two instances of the same kind", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const handlers = [
				Handler.promise(
					renameJson,
					async (payload) => void events.push(`json:${payload.target}`),
				),
				Handler.effect(renameExport, (payload) =>
					Effect.sync(() => events.push(`export:${payload.target}`)),
				),
				Handler.promise(renameSource, async () => void events.push("source")),
			];
			yield* Executor.effect(plan, { handlers });

			expect(events).toEqual(["json:config.json", "export:export-b", "source"]);
		}),
	);

	it.effect("rejects missing bindings before any precondition or body runs", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const handlers = [
				Handler.promise(renameJson, async () => void events.push("body"), {
					when: () => {
						events.push("precondition");

						return true;
					},
				}),
			];
			const error = yield* Effect.flip(
				Executor.effect(Plan.withRuntimeCoverage(plan), { handlers }),
			);

			expect(events).toEqual([]);
			expect(error._tag).toBe("HandlerCoverageError");
			if (error._tag !== "HandlerCoverageError") return;
			expect(error.issues.map((issue) => [issue._tag, issue.actionId])).toEqual([
				["Missing", "rename-export"],
				["Missing", "rename-source"],
			]);
			expect(error.report).toMatchObject({ status: "not-started", bodiesStarted: false });
			expect(Object.values(outcomes(error.report))).toEqual([
				"Unattempted",
				"Unattempted",
				"Unattempted",
			]);
		}),
	);

	it.effect("names the rule and replaced occurrences of a missing replacement handler", () =>
		Effect.gen(function* () {
			const a = touch("a");
			const b = touch("b");
			const combined = touch("a-and-b");
			const history = History.make({
				versions: [w1, w2, w3],
				migrations: [
					Migration.make("1-to-2", { from: w1, to: w2 })`${a}`,
					Migration.make("2-to-3", { from: w2, to: w3 })`${b}`,
				],
				rules: [Rule.replace("combine", { match: [a, b], replacement: [combined] })],
			});
			const error = yield* Effect.flip(
				Executor.effect(Plan.withRuntimeCoverage(planOf(history)), {
					handlers: [
						Handler.effect(a, () => Effect.void),
						Handler.effect(b, () => Effect.void),
					],
				}),
			);

			expect(error._tag === "HandlerCoverageError" && error.issues).toEqual([
				{
					_tag: "Missing",
					occurrenceId: "combine(1-to-2/a+2-to-3/b)/a-and-b",
					actionId: "a-and-b",
					description: "Touch a-and-b",
					migrationId: "1-to-2",
					rule: "combine",
					replaces: [
						{ occurrenceId: "1-to-2/a", description: "Touch a" },
						{ occurrenceId: "2-to-3/b", description: "Touch b" },
					],
				},
			]);
		}),
	);

	it.effect("rejects duplicate handlers and handlers for a different definition", () =>
		Effect.gen(function* () {
			const stale = RenameKey.make("rename-export", {
				target: "export-b",
				from: "old",
				to: "b",
			});
			const error = yield* Effect.flip(
				Executor.effect(plan, {
					handlers: [
						Handler.effect(renameJson, () => Effect.void),
						Handler.effect(renameJson, () => Effect.void),
						Handler.effect(stale, () => Effect.void),
						Handler.effect(renameSource, () => Effect.void),
					],
				}),
			);

			expect(
				error._tag === "HandlerCoverageError" && error.issues.map((issue) => issue._tag),
			).toEqual(["Duplicate", "Mismatched"]);
		}),
	);

	it.effect("skips false preconditions and stops after a failed precondition", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const first = touch("first");
			const skipped = touch("skipped");
			const rejected = touch("rejected");
			const later = touch("later");
			const nextStep = touch("next-step");
			const history = History.make({
				versions: [w1, w2, w3],
				migrations: [
					Migration.make("1-to-2", {
						from: w1,
						to: w2,
					})`${first}${skipped}${rejected}${later}`,
					Migration.make("2-to-3", { from: w2, to: w3 })`${nextStep}`,
				],
			});
			const error = yield* Effect.flip(
				Executor.effect(planOf(history), {
					handlers: [
						recording(events)(first),
						Handler.promise(skipped, async () => void events.push("skipped"), {
							when: async () => false,
							skipReason: "This project does not use JSON configuration",
						}),
						Handler.promise(rejected, async () => void events.push("rejected"), {
							when: () => Promise.reject(new Error("unreadable")),
						}),
						recording(events)(later),
						recording(events)(nextStep),
					],
				}),
			);

			expect(events).toEqual(["first"]);
			expect(error._tag).toBe("ExecutionFailed");
			if (error._tag !== "ExecutionFailed") return;
			expect(outcomes(error.report)).toEqual({
				first: "Completed",
				skipped: "Skipped",
				rejected: "Failed",
				later: "Unattempted",
				"next-step": "Unattempted",
			});
			expect(error.report.occurrences[1]?.outcome).toEqual({
				_tag: "Skipped",
				reason: "This project does not use JSON configuration",
			});
			const [failed] = error.failures;
			expect(failed?.outcome).toMatchObject({ _tag: "Failed", phase: "precondition" });
			expect(failed?.outcome._tag === "Failed" && failed.outcome.error).toMatchObject({
				_tag: "UnexpectedHandlerError",
				actionId: "rejected",
				phase: "precondition",
			});
			expect(error.report.bodiesStarted).toBe(true);
		}),
	);

	it.effect("keeps declared rejections and wraps unexpected ones with action identity", () =>
		Effect.gen(function* () {
			const declared = touch("declared");
			const unexpected = touch("unexpected");
			const first = yield* Effect.flip(
				Executor.effect(Plan.withRuntimeCoverage(planOf(single(declared), "2.0.0")), {
					handlers: [
						Handler.promise(
							declared,
							() => Promise.reject(new Codemod.TransformRejected("a.ts")),
							{
								errors: [
									(cause: unknown) => cause instanceof Codemod.TransformRejected,
								],
							},
						),
					],
				}),
			);
			const second = yield* Effect.flip(
				Executor.effect(Plan.withRuntimeCoverage(planOf(single(unexpected), "2.0.0")), {
					handlers: [Handler.promise(unexpected, () => Promise.reject("boom"))],
				}),
			);

			const errorOf = (error: typeof first | typeof second) =>
				error._tag === "ExecutionFailed" && error.failures[0]?.outcome._tag === "Failed"
					? error.failures[0].outcome.error
					: undefined;
			expect(errorOf(first)).toBeInstanceOf(Codemod.TransformRejected);
			expect(errorOf(second)).toMatchObject({
				_tag: "UnexpectedHandlerError",
				actionId: "unexpected",
				kind: "test.touch",
				phase: "body",
				cause: "boom",
			});
		}),
	);

	it.effect("lets in-flight siblings settle when a parallel branch fails", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const fails = touch("fails");
			const afterFailure = touch("after-failure");
			const slow = touch("slow");
			const nextStep = touch("next-step");
			const history = History.make({
				versions: [w1, w2, w3],
				migrations: [
					Migration.make("1-to-2", { from: w1, to: w2 })`${Action.parallel([
						Action.sequence([fails, afterFailure]),
						slow,
					])}`,
					Migration.make("2-to-3", { from: w2, to: w3 })`${nextStep}`,
				],
			});
			const fiber = yield* Effect.forkChild(
				Effect.flip(
					Executor.effect(planOf(history), {
						handlers: [
							Handler.effect(fails, () =>
								Effect.andThen(Effect.sleep("100 millis"), Effect.fail("broken")),
							),
							recording(events)(afterFailure),
							Handler.effect(slow, () =>
								Effect.gen(function* () {
									events.push("slow started");
									yield* Effect.sleep("1 second");
									events.push("slow finished");
								}),
							),
							recording(events)(nextStep),
						],
					}),
				),
			);
			yield* TestClock.adjust("1 second");
			const error = yield* Fiber.join(fiber);

			expect(events).toEqual(["slow started", "slow finished"]);
			expect(error._tag === "ExecutionFailed" && outcomes(error.report)).toEqual({
				fails: "Failed",
				"after-failure": "Unattempted",
				slow: "Completed",
				"next-step": "Unattempted",
			});
		}),
	);

	it.effect("interrupts only the timed-out action and lets siblings settle", () =>
		Effect.gen(function* () {
			const hangs = touch("hangs");
			const first = touch("first");
			const inFlight = touch("in-flight");
			const notAdmitted = touch("not-admitted");
			const history = History.make({
				versions: [w1, w2],
				migrations: [
					Migration.make("1-to-2", { from: w1, to: w2 })`${Action.parallel([
						hangs,
						Action.sequence([first, inFlight, notAdmitted]),
					])}`,
				],
			});
			const fiber = yield* Effect.forkChild(
				Effect.flip(
					Executor.effect(planOf(history, "2.0.0"), {
						timeout: "1 second",
						handlers: [
							Handler.effect(hangs, () => Effect.never),
							Handler.effect(first, () => Effect.sleep("600 millis")),
							Handler.effect(inFlight, () => Effect.sleep("600 millis")),
							Handler.effect(notAdmitted, () => Effect.void),
						],
					}),
				),
			);
			yield* TestClock.adjust("2 seconds");
			const error = yield* Fiber.join(fiber);

			expect(error).toMatchObject({ _tag: "ExecutionInterrupted", reason: "timeout" });
			if (error._tag !== "ExecutionInterrupted") return;
			expect(error.report.occurrences.map((entry) => entry.outcome)).toEqual([
				{ _tag: "Interrupted", phase: "body", reason: "timeout", settled: true },
				{ _tag: "Completed" },
				{ _tag: "Completed" },
				{ _tag: "Unattempted" },
			]);
		}),
	);

	it("cancels through an AbortSignal and reports whether Promises settled", async () => {
		const cooperative = touch("cooperative");
		const stubborn = touch("stubborn");
		const never = touch("never");
		const history = History.make({
			versions: [w1, w2, w3],
			migrations: [
				Migration.make("1-to-2", {
					from: w1,
					to: w2,
				})`${Action.parallel([cooperative, stubborn])}`,
				Migration.make("2-to-3", { from: w2, to: w3 })`${never}`,
			],
		});
		const controller = new AbortController();
		let started = 0;
		const start = () => {
			started += 1;
			if (started === 2) controller.abort();
		};
		const error: unknown = await Executor.runPromise(planOf(history), {
			signal: controller.signal,
			settleTimeout: "20 millis",
			handlers: [
				Handler.promise(
					cooperative,
					(_payload, { signal }) =>
						new Promise<void>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason));
							start();
						}),
				),
				Handler.promise(stubborn, () => {
					start();

					return new Promise<void>(() => {});
				}),
				Handler.promise(never, async () => {}),
			],
		}).then(
			() => undefined,
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(Executor.ExecutionInterrupted);
		if (!(error instanceof Executor.ExecutionInterrupted)) return;
		expect(error.reason).toBe("cancelled");
		expect(error.report.occurrences.map((entry) => entry.outcome)).toEqual([
			{ _tag: "Interrupted", phase: "body", reason: "cancelled", settled: true },
			{ _tag: "Interrupted", phase: "body", reason: "cancelled", settled: false },
			{ _tag: "Unattempted" },
		]);
		expect(error.message).toContain("may still be running");
	});

	it("reports settlement for Promise handlers bound through Handler.layer", async () => {
		const stubborn = touch("stubborn");
		const controller = new AbortController();
		const bindings = Handler.layer([
			Handler.promise(stubborn, () => {
				controller.abort();

				return new Promise<void>(() => {});
			}),
		]);
		const error: unknown = await Executor.runPromise(
			Plan.withRuntimeCoverage(planOf(single(stubborn), "2.0.0")),
			{
				signal: controller.signal,
				settleTimeout: "20 millis",
				services: bindings,
			},
		).then(
			() => undefined,
			(cause: unknown) => cause,
		);

		expect(
			error instanceof Executor.ExecutionInterrupted && error.report.occurrences[0]?.outcome,
		).toEqual({
			_tag: "Interrupted",
			phase: "body",
			reason: "cancelled",
			settled: false,
		});
	});

	it("rejects Promise execution with the partial report", async () => {
		const done = touch("done");
		const fails = touch("fails");
		const history = History.make({
			versions: [w1, w2],
			migrations: [Migration.make("1-to-2", { from: w1, to: w2 })`${done}${fails}`],
		});
		const error: unknown = await Executor.runPromise(planOf(history, "2.0.0"), {
			handlers: [
				Handler.promise(done, async () => {}),
				Handler.promise(fails, async () => {
					throw new Error("disk full");
				}),
			],
		}).then(
			() => undefined,
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(Executor.ExecutionFailed);
		expect(error instanceof Executor.ExecutionFailed && outcomes(error.report)).toEqual({
			done: "Completed",
			fails: "Failed",
		});
	});

	it.effect("runs handlers supplied through Handler.layer", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const failing = Handler.effect(renameSource, () => Effect.fail(new EditFailed()));
			const bindings = Handler.layer([recording(events)(renameExport), failing]);
			const error = yield* Effect.flip(
				Executor.effect(plan, { handlers: [recording(events)(renameJson)] }).pipe(
					Effect.provide(bindings),
				),
			);

			expect(events).toEqual(["rename-json", "rename-export"]);
			expect(error._tag === "ExecutionFailed" && error.failures[0]?.outcome).toMatchObject({
				_tag: "Failed",
				error: { _tag: "BoundHandlerError", actionId: "rename-source" },
			});
		}),
	);
});

describe("Executor admission, cancellation, and settlement", () => {
	it.effect("stops admission when a timeout fires, before the interrupted Promise settles", () =>
		Effect.gen(function* () {
			const hangs = touch("hangs");
			const first = touch("first");
			const second = touch("second");
			const third = touch("third");
			const history = History.make({
				versions: [w1, w2],
				migrations: [
					Migration.make("1-to-2", { from: w1, to: w2 })`${Action.parallel([
						hangs,
						Action.sequence([first, second, third]),
					])}`,
				],
			});
			const fiber = yield* Effect.forkChild(
				Effect.flip(
					Executor.effect(planOf(history, "2.0.0"), {
						timeout: "200 millis",
						settleTimeout: "600 millis",
						handlers: [
							Handler.promise(hangs, () => new Promise<void>(() => {})),
							// `second` is still running when `hangs` times out at 200 ms.
							Handler.effect(first, () => Effect.sleep("150 millis")),
							Handler.effect(second, () => Effect.sleep("100 millis")),
							Handler.effect(third, () => Effect.void),
						],
					}),
				),
			);
			yield* TestClock.adjust("2 seconds");
			const error = yield* Fiber.join(fiber);

			expect(
				error._tag === "ExecutionInterrupted" &&
					error.report.occurrences.map((entry) => entry.outcome),
			).toEqual([
				{ _tag: "Interrupted", phase: "body", reason: "timeout", settled: false },
				{ _tag: "Completed" },
				{ _tag: "Completed" },
				{ _tag: "Unattempted" },
			]);
		}),
	);

	it.effect(
		"limits branch concurrency and leaves queued branches unattempted after a failure",
		() =>
			Effect.gen(function* () {
				let active = 0;
				let peak = 0;
				const gated = (action: Action.Any, fails: boolean) =>
					Handler.effect(action, () =>
						Effect.gen(function* () {
							active += 1;
							peak = Math.max(peak, active);
							yield* Effect.sleep("100 millis");
							active -= 1;
							if (fails) yield* Effect.fail("broken");
						}),
					);
				const [a, b, c] = [touch("a"), touch("b"), touch("c")];
				const history = History.make({
					versions: [w1, w2],
					migrations: [
						Migration.make("1-to-2", { from: w1, to: w2 })`${Action.parallel(
							[a, b, c],
							{
								concurrency: 1,
							},
						)}`,
					],
				});
				const fiber = yield* Effect.forkChild(
					Effect.flip(
						Executor.effect(planOf(history, "2.0.0"), {
							handlers: [gated(a, false), gated(b, true), gated(c, false)],
						}),
					),
				);
				yield* TestClock.adjust("1 second");
				const error = yield* Fiber.join(fiber);

				expect(peak).toBe(1);
				expect(error._tag === "ExecutionFailed" && outcomes(error.report)).toEqual({
					a: "Completed",
					b: "Failed",
					c: "Unattempted",
				});
			}),
	);

	it("does not start a body when cancellation arrives during its precondition", async () => {
		const checked = touch("checked");
		const controller = new AbortController();
		let ran = false;
		const error: unknown = await Executor.runPromise(
			Plan.withRuntimeCoverage(planOf(single(checked), "2.0.0")),
			{
				signal: controller.signal,
				handlers: [
					Handler.promise(
						checked,
						async () => {
							ran = true;
						},
						{
							when: () => {
								controller.abort();

								return true;
							},
						},
					),
				],
			},
		).then(
			() => undefined,
			(cause: unknown) => cause,
		);

		expect(ran).toBe(false);
		expect(
			error instanceof Executor.ExecutionInterrupted && error.report.occurrences[0]?.outcome,
		).toEqual({
			_tag: "Interrupted",
			phase: "precondition",
			reason: "cancelled",
			settled: true,
		});
		expect(error instanceof Executor.ExecutionInterrupted && error.report.bodiesStarted).toBe(
			false,
		);
	});

	it("waits for an interrupted Promise within the settlement grace period", async () => {
		const settlesSoon = touch("settles-soon");
		const run = async (settleTimeout: Duration.Input) => {
			const controller = new AbortController();
			const error: unknown = await Executor.runPromise(
				Plan.withRuntimeCoverage(planOf(single(settlesSoon), "2.0.0")),
				{
					signal: controller.signal,
					settleTimeout,
					handlers: [
						Handler.promise(
							settlesSoon,
							(_payload, { signal }) =>
								new Promise<void>((resolve) => {
									// Settles 20 ms after the abort, ignoring the abort reason.
									signal.addEventListener("abort", () => {
										void Effect.runPromise(Effect.sleep("20 millis")).then(
											resolve,
										);
									});
									controller.abort();
								}),
						),
					],
				},
			).then(
				() => undefined,
				(cause: unknown) => cause,
			);

			return error instanceof Executor.ExecutionInterrupted
				? error.report.occurrences[0]?.outcome
				: undefined;
		};

		expect(await run("1 second")).toMatchObject({ _tag: "Interrupted", settled: true });
		expect(await run("1 millis")).toMatchObject({ _tag: "Interrupted", settled: false });
	});

	it("removes its abort listener when the run ends", async () => {
		const done = touch("done");
		const controller = new AbortController();
		const added = vi.spyOn(controller.signal, "addEventListener");
		const removed = vi.spyOn(controller.signal, "removeEventListener");
		await Executor.runPromise(Plan.withRuntimeCoverage(planOf(single(done), "2.0.0")), {
			signal: controller.signal,
			handlers: [Handler.promise(done, async () => {})],
		});

		expect(added).toHaveBeenCalledTimes(1);
		expect(removed).toHaveBeenCalledTimes(1);
	});

	it("applies cancellation and timeouts to dry-run preconditions", async () => {
		const checked = touch("checked");
		const evaluated: Array<string> = [];
		const dryRun = (
			options: { signal?: AbortSignal; timeout?: Duration.Input },
			when: () => Promise<boolean>,
		) =>
			Executor.runPromise(Plan.withRuntimeCoverage(planOf(single(checked), "2.0.0")), {
				...options,
				dryRun: true,
				settleTimeout: "1 millis",
				handlers: [Handler.promise(checked, async () => {}, { when })],
			}).then(
				() => undefined,
				(cause: unknown) => cause,
			);

		const controller = new AbortController();
		controller.abort();
		const cancelled = await dryRun({ signal: controller.signal }, async () => {
			evaluated.push("cancelled");

			return true;
		});
		const timedOut = await dryRun(
			{ timeout: "10 millis" },
			() => new Promise<boolean>(() => {}),
		);

		expect(evaluated).toEqual([]);
		expect(cancelled).toMatchObject({
			_tag: "ExecutionInterrupted",
			reason: "cancelled",
			report: { mode: "dry-run", status: "interrupted" },
		});
		expect(
			timedOut instanceof Executor.ExecutionInterrupted &&
				timedOut.report.occurrences[0]?.outcome,
		).toEqual({
			_tag: "Interrupted",
			phase: "precondition",
			reason: "timeout",
			settled: false,
		});
	});
});

describe("Executor dry runs", () => {
	it.effect("never runs bodies and reports checks behind unapplied work as undetermined", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const skips = touch("skips");
			const create = touch("create");
			const update = touch("update");
			const independent = touch("independent");
			const later = touch("later");
			const history = History.make({
				versions: [w1, w2, w3],
				migrations: [
					Migration.make("1-to-2", { from: w1, to: w2 })`
						${skips}
						${Action.parallel([Action.sequence([create, update]), independent])}
					`,
					Migration.make("2-to-3", { from: w2, to: w3 })`${later}`,
				],
			});
			const checked = (action: Action.Any, applies: boolean) =>
				Handler.promise(action, async () => void events.push(`body:${action.id}`), {
					when: () => {
						events.push(`check:${action.id}`);

						return applies;
					},
					skipReason: `${action.id} does not apply`,
				});
			const result = yield* Executor.effect(Plan.withRuntimeCoverage(planOf(history)), {
				dryRun: true,
				handlers: [
					checked(skips, false),
					Handler.promise(create, async () => void events.push("body:create")),
					checked(update, true),
					checked(independent, true),
					checked(later, true),
				],
			});
			const undetermined = {
				_tag: "Undetermined",
				reason: "The precondition depends on earlier actions that a dry run does not apply.",
			};

			expect(events).toEqual(["check:skips", "check:independent"]);
			expect(result).toMatchObject({
				mode: "dry-run",
				status: "would-complete",
				bodiesStarted: false,
			});
			expect(result.occurrences.map((entry) => entry.outcome)).toEqual([
				{ _tag: "WouldSkip", reason: "skips does not apply" },
				{ _tag: "WouldExecute", evaluated: false },
				undetermined,
				{ _tag: "WouldExecute", evaluated: true },
				undetermined,
			]);
		}),
	);

	it.effect("reports a failed check as a failure, not a skip", () =>
		Effect.gen(function* () {
			const broken = touch("broken");
			const after = touch("after");
			const history = History.make({
				versions: [w1, w2],
				migrations: [Migration.make("1-to-2", { from: w1, to: w2 })`${broken}${after}`],
			});
			const result = yield* Executor.effect(planOf(history, "2.0.0"), {
				dryRun: true,
				handlers: [
					Handler.effect(broken, () => Effect.void, {
						when: () => Effect.fail("unreadable"),
					}),
					Handler.effect(after, () => Effect.void),
				],
			});

			expect(result.status).toBe("would-fail");
			expect(result.occurrences.map((entry) => entry.outcome._tag)).toEqual([
				"PreconditionFailed",
				"Undetermined",
			]);
		}),
	);
});
