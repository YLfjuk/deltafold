import { describe, expect, it, vi } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Result, Scope } from "effect";
import { TestClock } from "effect/testing";

import { Action, Executor, Handler, History, Migration, Plan, Version } from "deltafold";

const Touch = Action.define<{ readonly name: string }>("test.touch", {
	describe: ({ name }) => `Touch ${name}`,
});
const touch = <const Id extends string>(id: Id) => Touch.make(id, { name: id });

const v1 = Version.make("1.0.0", { changes: [] });
const v2 = Version.make("2.0.0", { previous: v1, changes: [] });

/** A runtime-coverage plan with one migration whose body is `content`. */
const planOf = (content: Action.Step) => {
	const history = History.make({
		versions: [v1, v2],
		migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${content}`],
	});
	const result = History.resolve(history, { from: "1.0.0", to: "2.0.0" });
	if (Result.isFailure(result)) throw result.failure;

	return Plan.withRuntimeCoverage(result.success);
};

const outcomesOf = (report: Executor.Report) => report.occurrences.map((entry) => entry.outcome);

const reportOf = (error: unknown) =>
	error instanceof Executor.ExecutionFailed || error instanceof Executor.ExecutionInterrupted
		? error.report
		: undefined;

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(cause: unknown) => cause,
	);

/** A lock that records its acquisition and the exit it was released with. */
const lockFor = (events: Array<string>, name: string) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			events.push(`lock:${name}`);

			return { name };
		}),
		(_lock, exit) =>
			Effect.sync(() =>
				events.push(`unlock:${name}:${Exit.isSuccess(exit) ? "success" : "failure"}`),
			),
	);

const ConfigEditor = Context.Service<{ readonly update: (target: string) => Promise<void> }>(
	"test/prepare/ConfigEditor",
);

/** Runs one action with a 100 ms timeout and returns its outcome. */
const timedOutcome = (action: Action.Any, handler: Handler.Handler<Action.Any>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(
			Effect.flip(
				Executor.effect(planOf(action), {
					timeout: "100 millis",
					handlers: [handler],
				}),
			),
		);
		yield* TestClock.adjust("1 second");

		return reportOf(yield* Fiber.join(fiber))?.occurrences[0]?.outcome;
	});

/** A services layer that records its acquisition and release. */
const editorLayer = (events: Array<string>, release: Effect.Effect<void> = Effect.void) =>
	Layer.effect(
		ConfigEditor,
		Effect.acquireRelease(
			Effect.sync(() => {
				events.push("acquire");

				return ConfigEditor.of({
					update: async (target) => void events.push(`update:${target}`),
				});
			}),
			() =>
				Effect.andThen(
					Effect.sync(() => events.push("release")),
					release,
				),
		),
	);

describe("Prepared handlers in real runs", () => {
	it.effect("prepares once and applies the same value", () =>
		Effect.gen(function* () {
			const action = touch("edit");
			const value = { edits: ["a"] };
			const seen: Array<unknown> = [];
			let prepared = 0;
			const report = yield* Executor.effect(planOf(action), {
				handlers: [
					Handler.promise(action, {
						prepare: async () => {
							prepared += 1;

							return Handler.prepared(value);
						},
						apply: async (received, { payload }) => {
							seen.push(received, payload.name);
						},
					}),
				],
			});

			expect(prepared).toBe(1);
			expect(seen[0]).toBe(value);
			expect(seen[1]).toBe("edit");
			expect(outcomesOf(report)).toEqual([{ _tag: "Completed", performer: "automated" }]);
			expect(report.bodiesStarted).toBe(true);
		}),
	);

	it.effect("applies a prepared value that looks like a skip", () =>
		Effect.gen(function* () {
			const action = touch("edit");
			const seen: Array<unknown> = [];
			const report = yield* Executor.effect(planOf(action), {
				handlers: [
					Handler.effect(action, {
						prepare: () =>
							Effect.succeed(Handler.prepared({ _tag: "Skip", reason: "data" })),
						apply: (prepared) => Effect.sync(() => seen.push(prepared)),
					}),
				],
			});

			expect(seen).toEqual([{ _tag: "Skip", reason: "data" }]);
			expect(outcomesOf(report)).toEqual([{ _tag: "Completed", performer: "automated" }]);
		}),
	);

	it.effect("skips without applying and reports the reason", () =>
		Effect.gen(function* () {
			const action = touch("edit");
			let applied = false;
			const report = yield* Executor.effect(planOf(action), {
				handlers: [
					Handler.effect(action, {
						prepare: () => Effect.succeed(Handler.skip("Nothing to change")),
						apply: () => Effect.sync(() => (applied = true)),
					}),
				],
			});

			expect(applied).toBe(false);
			expect(outcomesOf(report)).toEqual([{ _tag: "Skipped", reason: "Nothing to change" }]);
			expect(report.bodiesStarted).toBe(false);
		}),
	);

	it.effect("fails an Effect prepare phase with its typed error in the prepare phase", () =>
		Effect.gen(function* () {
			const action = touch("edit");
			const error = yield* Effect.flip(
				Executor.effect(planOf(action), {
					handlers: [
						Handler.effect(action, {
							prepare: () => Effect.fail("unreadable" as const),
							apply: () => Effect.void,
						}),
					],
				}),
			);

			expect(error._tag === "deltafold/ExecutionFailed" && outcomesOf(error.report)).toEqual([
				expect.objectContaining({ _tag: "Failed", phase: "prepare", error: "unreadable" }),
			]);
		}),
	);

	it("reports a prepare phase that returns a plain value as unexpected", async () => {
		const action = touch("edit");
		let applied = false;
		const error = await rejection(
			Executor.runPromise(planOf(action), {
				handlers: [
					Handler.promise(action, {
						// @ts-expect-error a plain value is not a preparation.
						prepare: async () => true,
						apply: async () => {
							applied = true;
						},
					}),
				],
			}),
		);

		expect(applied).toBe(false);
		expect(reportOf(error)?.occurrences[0]?.outcome).toMatchObject({
			_tag: "Failed",
			phase: "prepare",
			error: { _tag: "deltafold/UnexpectedHandlerError", phase: "prepare" },
		});
	});

	it.effect("gives each phase its own timeout window", () =>
		Effect.gen(function* () {
			const action = touch("edit");
			const fiber = yield* Effect.forkChild(
				Executor.effect(planOf(action), {
					timeout: "200 millis",
					handlers: [
						Handler.effect(action, {
							prepare: () =>
								Effect.as(Effect.sleep("150 millis"), Handler.prepared()),
							apply: () => Effect.sleep("150 millis"),
						}),
					],
				}),
			);
			yield* TestClock.adjust("1 second");
			const report = yield* Fiber.join(fiber);

			expect(outcomesOf(report)).toEqual([{ _tag: "Completed", performer: "automated" }]);
		}),
	);

	it.effect("times out each phase separately and reports the phase", () =>
		Effect.gen(function* () {
			const slowPrepare = touch("slow-prepare");
			const slowApply = touch("slow-apply");
			expect(
				yield* timedOutcome(
					slowPrepare,
					Handler.effect(slowPrepare, {
						prepare: () => Effect.never,
						apply: () => Effect.void,
					}),
				),
			).toEqual({ _tag: "Interrupted", phase: "prepare", reason: "timeout", settled: true });
			expect(
				yield* timedOutcome(
					slowApply,
					Handler.effect(slowApply, {
						prepare: () => Effect.succeed(Handler.prepared()),
						apply: () => Effect.never,
					}),
				),
			).toEqual({ _tag: "Interrupted", phase: "apply", reason: "timeout", settled: true });
		}),
	);

	it.effect("lets an occurrence that started preparing apply after a sibling fails", () =>
		Effect.gen(function* () {
			const fails = touch("fails");
			const preparing = touch("preparing");
			const fiber = yield* Effect.forkChild(
				Effect.flip(
					Executor.effect(planOf(Action.parallel([fails, preparing])), {
						handlers: [
							Handler.effect(fails, () =>
								Effect.andThen(Effect.sleep("50 millis"), Effect.fail("broken")),
							),
							Handler.effect(preparing, {
								prepare: () =>
									Effect.as(Effect.sleep("100 millis"), Handler.prepared()),
								apply: () => Effect.void,
							}),
						],
					}),
				),
			);
			yield* TestClock.adjust("1 second");
			const error = yield* Fiber.join(fiber);

			expect(error._tag).toBe("deltafold/ExecutionFailed");
			if (error._tag !== "deltafold/ExecutionFailed") throw error;
			expect(outcomesOf(error.report).map((outcome) => outcome._tag)).toEqual([
				"Failed",
				"Completed",
			]);
		}),
	);
});

describe("Occurrence scopes", () => {
	it.effect("holds a resource from prepare through apply and releases it once", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const action = touch("edit");
			yield* Executor.effect(planOf(action), {
				handlers: [
					Handler.effect(action, {
						prepare: () =>
							Effect.map(lockFor(events, "edit"), (lock) => Handler.prepared(lock)),
						apply: (lock) => Effect.sync(() => events.push(`apply:${lock.name}`)),
					}),
				],
			});

			expect(events).toEqual(["lock:edit", "apply:edit", "unlock:edit:success"]);
		}),
	);

	it.effect("releases on skip, failure, and cancellation with how the occurrence ended", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const skips = touch("skips");
			const fails = touch("fails");
			yield* Executor.effect(planOf(skips), {
				handlers: [
					Handler.effect(skips, {
						prepare: () =>
							Effect.as(lockFor(events, "skips"), Handler.skip("Nothing to do")),
						apply: () => Effect.sync(() => events.push("apply:skips")),
					}),
				],
			});
			yield* Effect.flip(
				Executor.effect(planOf(fails), {
					handlers: [
						Handler.effect(fails, {
							prepare: () =>
								Effect.map(lockFor(events, "fails"), (lock) =>
									Handler.prepared(lock),
								),
							apply: () => Effect.fail("broken"),
						}),
					],
				}),
			);

			expect(events).toEqual([
				"lock:skips",
				"unlock:skips:success",
				"lock:fails",
				"unlock:fails:failure",
			]);
		}),
	);

	it("releases a prepared resource without applying when cancelled during prepare", async () => {
		const events: Array<string> = [];
		const action = touch("edit");
		const controller = new AbortController();
		const error = await rejection(
			Executor.runPromise(planOf(action), {
				signal: controller.signal,
				handlers: [
					Handler.effect(action, {
						prepare: () =>
							Effect.andThen(
								lockFor(events, "edit"),
								Effect.andThen(
									Effect.sync(() => controller.abort()),
									Effect.never,
								),
							),
						apply: () => Effect.sync(() => events.push("apply")),
					}),
				],
			}),
		);

		expect(events).toEqual(["lock:edit", "unlock:edit:failure"]);
		expect(reportOf(error)?.occurrences[0]?.outcome).toEqual({
			_tag: "Interrupted",
			phase: "prepare",
			reason: "cancelled",
			settled: true,
		});
	});

	it.effect("releases a resource when the executing fiber is interrupted", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const action = touch("edit");
			const fiber = yield* Effect.forkChild(
				Executor.effect(planOf(action), {
					handlers: [
						Handler.effect(action, {
							prepare: () =>
								Effect.map(lockFor(events, "edit"), (lock) =>
									Handler.prepared(lock),
								),
							apply: () => Effect.never,
						}),
					],
				}),
			);
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(fiber);

			expect(events).toEqual(["lock:edit", "unlock:edit:failure"]);
		}),
	);

	it.effect("fails an otherwise completed occurrence when its cleanup fails", () =>
		Effect.gen(function* () {
			const action = touch("edit");
			const later = touch("later");
			const error = yield* Effect.flip(
				Executor.effect(planOf(Action.sequence([action, later])), {
					handlers: [
						Handler.effect(action, {
							prepare: () =>
								Effect.as(
									Effect.addFinalizer(() => Effect.die("unlock failed")),
									Handler.prepared(),
								),
							apply: () => Effect.void,
						}),
						Handler.effect(later, () => Effect.void),
					],
				}),
			);

			expect(error._tag).toBe("deltafold/ExecutionFailed");
			if (error._tag !== "deltafold/ExecutionFailed") throw error;
			const [first, second] = outcomesOf(error.report);
			expect(first).toMatchObject({ _tag: "Failed", phase: "apply", error: undefined });
			expect(second).toEqual({ _tag: "Unattempted" });
		}),
	);
});

describe("Prepared handlers in dry runs", () => {
	it.effect("prepares without applying and releases prepared resources", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const prepared = touch("prepared");
			const skipped = touch("skipped");
			const direct = touch("direct");
			const report = yield* Executor.effect(
				planOf(Action.parallel([prepared, skipped, direct])),
				{
					dryRun: true,
					handlers: [
						Handler.effect(prepared, {
							prepare: () =>
								Effect.map(lockFor(events, "prepared"), (lock) =>
									Handler.prepared(lock),
								),
							apply: () => Effect.sync(() => events.push("apply:prepared")),
						}),
						Handler.promise(skipped, {
							prepare: async () => Handler.skip("Already renamed"),
							apply: async () => void events.push("apply:skipped"),
						}),
						Handler.promise(direct, async () => void events.push("apply:direct")),
					],
				},
			);

			expect(events).toEqual(["lock:prepared", "unlock:prepared:success"]);
			expect(outcomesOf(report)).toEqual([
				{ _tag: "WouldExecute", evaluated: true, performer: "automated" },
				{ _tag: "WouldSkip", reason: "Already renamed" },
				{ _tag: "WouldExecute", evaluated: false, performer: "automated" },
			]);
			expect(report).toMatchObject({ status: "would-complete", bodiesStarted: false });
		}),
	);

	it.effect("reports a failed preparation and leaves later preparations undetermined", () =>
		Effect.gen(function* () {
			const broken = touch("broken");
			const after = touch("after");
			let prepared = 0;
			const report = yield* Executor.effect(planOf(Action.parallel([broken, after])), {
				dryRun: true,
				handlers: [
					Handler.promise(broken, {
						prepare: () => Promise.reject(new Error("unreadable")),
						apply: async () => {},
					}),
					Handler.promise(after, {
						prepare: async () => {
							prepared += 1;

							return Handler.prepared();
						},
						apply: async () => {},
					}),
				],
			});

			expect(prepared).toBe(0);
			expect(report.status).toBe("would-fail");
			expect(outcomesOf(report)).toEqual([
				expect.objectContaining({
					_tag: "PreparationFailed",
					error: expect.objectContaining({ phase: "prepare" }),
				}),
				{
					_tag: "Undetermined",
					reason: 'Execution would stop at the failed preparation of "1-to-2/broken".',
					performer: "automated",
				},
			]);
		}),
	);
});

describe("Interrupted Promises that outlive the report", () => {
	it("keeps the run's services layer until an interrupted apply settles", async () => {
		const events: Array<string> = [];
		const action = touch("edit");
		const controller = new AbortController();
		let settle: (() => void) | undefined;
		const error = await rejection(
			Executor.runPromise(planOf(action), {
				signal: controller.signal,
				settleTimeout: "1 millis",
				services: editorLayer(events),
				handlers: [
					Handler.promise(
						action,
						async (_payload, { services: { editor } }) => {
							controller.abort();
							await new Promise<void>((resolve) => {
								settle = resolve;
							});
							await editor.update("late");
						},
						{ services: { editor: ConfigEditor } },
					),
				],
			}),
		);

		expect(reportOf(error)?.occurrences[0]?.outcome).toEqual({
			_tag: "Interrupted",
			phase: "apply",
			reason: "cancelled",
			settled: false,
		});
		expect(events).toEqual(["acquire"]);

		settle?.();
		await vi.waitFor(() => expect(events).toContain("release"));
		expect(events).toEqual(["acquire", "update:late", "release"]);
	});

	it("discards a late preparation and keeps services for its late work", async () => {
		const events: Array<string> = [];
		const action = touch("edit");
		let settle: ((value: Handler.Preparation<string>) => void) | undefined;
		const error = await rejection(
			Executor.runPromise(planOf(action), {
				timeout: "10 millis",
				settleTimeout: "1 millis",
				services: editorLayer(events),
				handlers: [
					Handler.promise(
						action,
						{
							prepare: async (_payload, { services: { editor } }) => {
								const preparation = await new Promise<Handler.Preparation<string>>(
									(resolve) => {
										settle = resolve;
									},
								);
								// Late work after the report still has the services it acquired.
								await editor.update("late-prepare");

								return preparation;
							},
							apply: async (value) => void events.push(`apply:${value}`),
						},
						{ services: { editor: ConfigEditor } },
					),
				],
			}),
		);

		expect(reportOf(error)?.occurrences[0]?.outcome).toEqual({
			_tag: "Interrupted",
			phase: "prepare",
			reason: "timeout",
			settled: false,
		});
		expect(events).toEqual(["acquire"]);

		settle?.(Handler.prepared("late"));
		await vi.waitFor(() => expect(events).toContain("release"));
		expect(events).toEqual(["acquire", "update:late-prepare", "release"]);
	});

	it("closes a retained occurrence scope after settlement and before the services layer", async () => {
		const events: Array<string> = [];
		const action = touch("edit");
		let settle: (() => void) | undefined;
		let openGate: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const promised = Handler.promise(
			action,
			() =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
			{ services: { editor: ConfigEditor } },
		);
		// Promise callbacks cannot register cleanup, so the occurrence finalizer goes in
		// through the handler's scope boundary. It waits on a gate so the test can tell
		// whether the layer waits for cleanup to finish, not only to start.
		const handler: typeof promised = {
			...promised,
			prepare: (scope) =>
				Effect.andThen(
					Scope.addFinalizer(
						scope,
						Effect.sync(() => events.push("finalize:start")).pipe(
							Effect.andThen(Effect.promise(() => gate)),
							Effect.andThen(Effect.sync(() => events.push("finalize:end"))),
						),
					),
					promised.prepare(scope),
				),
		};
		const error = await rejection(
			Executor.runPromise(planOf(action), {
				timeout: "10 millis",
				settleTimeout: "1 millis",
				services: editorLayer(events),
				handlers: [handler],
			}),
		);

		expect(reportOf(error)?.occurrences[0]?.outcome).toEqual({
			_tag: "Interrupted",
			phase: "apply",
			reason: "timeout",
			settled: false,
		});
		expect(events).toEqual(["acquire"]);

		settle?.();
		await vi.waitFor(() => expect(events).toContain("finalize:start"));
		await Effect.runPromise(Effect.sleep("20 millis"));
		expect(events).toEqual(["acquire", "finalize:start"]);

		openGate?.();
		await vi.waitFor(() => expect(events).toContain("release"));
		expect(events).toEqual(["acquire", "finalize:start", "finalize:end", "release"]);
	});

	it("releases services after a late rejection", async () => {
		const events: Array<string> = [];
		const action = touch("edit");
		let fail: ((cause: unknown) => void) | undefined;
		await rejection(
			Executor.runPromise(planOf(action), {
				timeout: "10 millis",
				settleTimeout: "1 millis",
				services: editorLayer(events),
				handlers: [
					Handler.promise(
						action,
						() =>
							new Promise<void>((_resolve, reject) => {
								fail = reject;
							}),
						{ services: { editor: ConfigEditor } },
					),
				],
			}),
		);

		expect(events).toEqual(["acquire"]);
		fail?.(new Error("late failure"));
		await vi.waitFor(() => expect(events).toEqual(["acquire", "release"]));
	});

	it("releases services right away when interrupted Promises settled in time", async () => {
		const events: Array<string> = [];
		const action = touch("edit");
		const controller = new AbortController();
		await rejection(
			Executor.runPromise(planOf(action), {
				signal: controller.signal,
				settleTimeout: "1 second",
				services: editorLayer(events),
				handlers: [
					Handler.promise(
						action,
						(_payload, { signal }) =>
							new Promise<void>((_resolve, reject) => {
								signal.addEventListener("abort", () => reject(signal.reason));
								controller.abort();
							}),
						{ services: { editor: ConfigEditor } },
					),
				],
			}),
		);

		expect(events).toEqual(["acquire", "release"]);
	});

	it("logs a cleanup failure after the report and leaves the report unchanged", async () => {
		const events: Array<string> = [];
		const action = touch("edit");
		let settle: (() => void) | undefined;
		const logged = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const error = await rejection(
				Executor.runPromise(planOf(action), {
					timeout: "10 millis",
					settleTimeout: "1 millis",
					services: editorLayer(events, Effect.die("release failed")),
					handlers: [
						Handler.promise(
							action,
							() =>
								new Promise<void>((resolve) => {
									settle = resolve;
								}),
							{ services: { editor: ConfigEditor } },
						),
					],
				}),
			);
			const report = reportOf(error);

			settle?.();
			await vi.waitFor(() =>
				expect(
					logged.mock.calls.some((call: Array<unknown>) =>
						call.some((part) => String(part).includes("cleanup failed")),
					),
				).toBe(true),
			);
			const call = logged.mock.calls.find((parts: Array<unknown>) =>
				parts.some((part) => String(part).includes("cleanup failed")),
			);

			expect(call).toContainEqual({ owner: "services layer" });
			expect(events).toEqual(["acquire", "release"]);
			expect(report?.occurrences.map((entry) => entry.outcome)).toEqual([
				{ _tag: "Interrupted", phase: "apply", reason: "timeout", settled: false },
			]);
		} finally {
			logged.mockRestore();
		}
	});
});
