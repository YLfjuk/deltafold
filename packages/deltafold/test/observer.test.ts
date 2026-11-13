import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Duration, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";

import {
	Action,
	Executor,
	Handler,
	History,
	Interaction,
	Migration,
	Observer,
	Package,
	Plan,
	Rule,
	Version,
} from "deltafold";

const Touch = Action.define<{ readonly name: string }>("test.touch", {
	describe: ({ name }) => `Touch ${name}`,
});
const touch = <const Id extends string>(id: Id) => Touch.make(id, { name: id });

const v1 = Version.make("1.0.0", { changes: [] });
const v2 = Version.make("2.0.0", { previous: v1, changes: [] });
const v3 = Version.make("3.0.0", { previous: v2, changes: [] });
const v4 = Version.make("4.0.0", { previous: v3, changes: [] });
const v5 = Version.make("5.0.0", { previous: v4, changes: [] });

const planOf = <A extends Action.Any>(history: History.History<A>, to: string) => {
	const result = History.resolve(history, { from: "1.0.0", to });
	if (Result.isFailure(result)) throw result.failure;

	return result.success;
};

const typeOnly = (_check: () => void) => {};

const sleeps = <A extends Action.Any>(action: A, duration: Duration.Input) =>
	Handler.effect(action, () => Effect.sleep(duration), { when: () => Effect.succeed(true) });

const answering = (answer: Interaction.Answer) => Interaction.promise(async () => answer);

const ok = <A extends Action.Any>(action: A) => Handler.effect(action, () => Effect.void);

const recorder = () => {
	const events: Array<Observer.Event> = [];

	return { events, observer: Observer.sync((event) => void events.push(event)) };
};

const tags = (events: ReadonlyArray<Observer.Event>) =>
	events.map((event) => {
		switch (event._tag) {
			case "StepStarted":
			case "StepSettled":
				return `${event._tag}:${event.step.id}`;
			case "ActionPhaseStarted":
				return `${event._tag}:${event.action.action}:${event.phase}`;
			case "ActionSettled":
				return `${event._tag}:${event.action.action}:${event.outcome._tag}`;
		}

		return event._tag;
	});

/** Checks the guarantees every event stream must keep, against the final report. */
const checkInvariants = (events: ReadonlyArray<Observer.Event>, report?: Executor.Report) => {
	expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
	expect(events[0]?._tag).toBe("RunStarted");
	expect(events.filter((event) => event._tag === "RunStarted")).toHaveLength(1);
	expect(events.filter((event) => event._tag === "RunFinished")).toHaveLength(1);
	expect(events.at(-1)?._tag).toBe("RunFinished");

	for (const [index, event] of events.entries()) {
		const previous = events[index - 1];
		if (previous === undefined) continue;
		expect(event.progress.actions.finished).toBeGreaterThanOrEqual(
			previous.progress.actions.finished,
		);
		expect(event.progress.steps.finished).toBeGreaterThanOrEqual(
			previous.progress.steps.finished,
		);
	}

	const started = new Set<string>();
	const settled: Array<string> = [];
	for (const event of events) {
		if (event._tag === "ActionPhaseStarted") started.add(event.action.occurrence);
		if (event._tag === "ActionSettled") settled.push(event.action.occurrence);
	}
	expect(new Set(settled).size).toBe(settled.length);
	const finished = events.at(-1);
	// After fiber interruption, occurrences that were running never settle.
	if (finished?._tag === "RunFinished" && !finished.report) return;
	for (const occurrence of started) expect(settled).toContain(occurrence);

	if (report === undefined || finished?._tag !== "RunFinished") return;
	expect(finished.status).toBe(report.status);
	expect(finished.report).toBe(true);
	const counts: Record<string, number> = {};
	for (const entry of report.occurrences)
		counts[entry.outcome._tag] = (counts[entry.outcome._tag] ?? 0) + 1;
	for (const [tag, count] of Object.entries(finished.counts)) {
		if (tag !== "unsettled") expect([tag, count]).toEqual([tag, counts[tag] ?? 0]);
	}
};

describe("Package.withObserver", () => {
	const a = touch("a");
	const history = History.make({
		versions: [v1, v2],
		migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${a}`],
	});
	const pkg = Package.make("@acme/widgets", { history });

	it("returns a new package and appends observers in attachment order", () => {
		const first = Observer.sync(() => {});
		const second = Observer.sync(() => {});
		const piped = pkg.pipe(Package.withObserver(first), Package.withObserver(second));
		const dataFirst = Package.withObserver(Package.withObserver(pkg, first), second);

		expect(pkg.observers).toEqual([]);
		expect(piped.observers).toEqual([first, second]);
		expect(dataFirst.observers).toEqual([first, second]);
		expect(piped).toMatchObject({ _tag: "Package", name: "@acme/widgets", history });
		expect(Package.isPackage(piped)).toBe(true);
	});

	it("causes no events until the observers reach an executor", async () => {
		const { events, observer } = recorder();
		const observed = pkg.pipe(Package.withObserver(observer));
		const plan = planOf(observed.history, "2.0.0");

		await Executor.runPromise(plan, { handlers: [ok(a)] });
		expect(events).toEqual([]);

		await Executor.runPromise(plan, { handlers: [ok(a)], observers: observed.observers });
		expect(tags(events)).toEqual([
			"RunStarted",
			"StepStarted:1-to-2",
			"ActionPhaseStarted:a:body",
			"ActionSettled:a:Completed",
			"StepSettled:1-to-2",
			"RunFinished",
		]);
	});
});

describe("Observer typing", () => {
	const Logger = Context.Service<{ readonly log: (line: string) => Effect.Effect<void> }>(
		"test/Logger",
	);
	type Logger = Context.Service.Identifier<typeof Logger>;
	const Progress = Context.Service<{ readonly tick: () => Effect.Effect<void> }>("test/Progress");
	type Progress = Context.Service.Identifier<typeof Progress>;

	const a = touch("a");
	const b = touch("b");
	const history = History.make({
		versions: [v1, v2],
		migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${a}${b}`],
	});
	const plan = planOf(history, "2.0.0");
	const pkg = Package.make("@acme/widgets", { history });
	const logging = Observer.effect((event) =>
		Effect.flatMap(Effect.service(Logger), (logger) => logger.log(event._tag)),
	);

	it("carries observer services through packages and arrays into the execution", () => {
		const shared = pkg.pipe(Package.withObserver(logging));
		const perRun = shared.pipe(
			Package.withObserver(
				Observer.effect(() =>
					Effect.flatMap(Effect.service(Progress), (bar) => bar.tick()),
				),
			),
		);
		const fromPackage = Executor.effect(plan, {
			handlers: [ok(a), ok(b)],
			observers: perRun.observers,
		});
		const fromArray = Executor.effect(plan, {
			handlers: [ok(a), ok(b)],
			observers: [logging, Observer.sync(() => {})],
		});

		expectTypeOf<Effect.Services<typeof fromPackage>>().toEqualTypeOf<Logger | Progress>();
		expectTypeOf<Effect.Services<typeof fromArray>>().toEqualTypeOf<Logger>();
		expectTypeOf(pkg).toEqualTypeOf<Package.Package<typeof a | typeof b>>();
		expectTypeOf(perRun).toExtend<Package.Any>();
	});

	it("keeps handler coverage and service checks independent of observers", () => {
		expect.assertions(0);
		typeOnly(() => {
			// @ts-expect-error b has no handler.
			Executor.effect(plan, { handlers: [ok(a)], observers: [logging] });
			// @ts-expect-error the Logger service is missing.
			void Executor.runPromise(plan, { handlers: [ok(a), ok(b)], observers: [logging] });
			void Executor.runPromise(plan, {
				handlers: [ok(a), ok(b)],
				observers: [logging],
				services: Context.make(Logger, { log: () => Effect.void }),
			});
			void Executor.runPromise(plan, {
				handlers: [ok(a), ok(b)],
				observers: [Observer.sync(() => {}), Observer.promise(async () => {})],
			});
		});
	});

	it("narrows events by tag", () => {
		Observer.sync((event) => {
			if (event._tag === "ActionSettled") {
				expectTypeOf(event.outcome._tag).toExtend<string>();
				expectTypeOf(event.action.sources).toEqualTypeOf<ReadonlyArray<string>>();
			}
		});
		Observer.promise(async (event, { signal }) => {
			expectTypeOf(event).toEqualTypeOf<Observer.Event>();
			expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
		});
	});
});

describe("Execution steps and provenance", () => {
	it("counts steps with actions and prose-only steps, and lists omitted steps", async () => {
		const [rename, restore, kept] = [touch("rename"), touch("restore"), touch("kept")];
		const history = History.make({
			versions: [v1, v2, v3, v4, v5],
			migrations: [
				Migration.make("1-to-2", { from: v1, to: v2 })`${rename}`,
				Migration.make("2-to-3", { from: v2, to: v3 })`${restore}`,
				Migration.noop("3-to-4", { from: v3, to: v4 }),
				Migration.make("4-to-5", { from: v4, to: v5 })`
					Rotate your API keys by hand.
					${kept}
				`,
			],
			rules: [Rule.replace("cancel", { match: [rename, restore], replacement: [] })],
		});
		const proseHistory = History.make({
			versions: [v1, v2, v3],
			migrations: [
				Migration.make("1-to-2", { from: v1, to: v2 })`Rotate your API keys by hand.`,
				Migration.make("2-to-3", { from: v2, to: v3 })`${kept}`,
			],
		});
		const { events, observer } = recorder();

		const report = await Executor.runPromise(
			Plan.withRuntimeCoverage(planOf(history, "5.0.0")),
			{
				handlers: [ok(kept)],
				observers: [observer],
			},
		);
		checkInvariants(events, report);
		const started = events[0];
		expect(started?._tag === "RunStarted" && started.steps).toMatchObject([
			{ id: "1-to-2", kind: "omitted", reason: "all-actions-removed", occurrences: [] },
			{ id: "2-to-3", kind: "omitted", reason: "all-actions-removed", occurrences: [] },
			{ id: "3-to-4", kind: "omitted", reason: "noop", occurrences: [] },
			{ id: "4-to-5", kind: "execute", index: 3, occurrences: ["4-to-5/kept"] },
		]);
		expect(started?.progress).toEqual({
			steps: { total: 1, finished: 0 },
			actions: { total: 1, running: 0, finished: 0 },
		});

		events.length = 0;
		const proseReport = await Executor.runPromise(planOf(proseHistory, "3.0.0"), {
			handlers: [ok(kept)],
			observers: [observer],
		});
		checkInvariants(events, proseReport);
		expect(tags(events)).toEqual([
			"RunStarted",
			"StepStarted:1-to-2",
			"StepSettled:1-to-2",
			"StepStarted:2-to-3",
			"ActionPhaseStarted:kept:body",
			"ActionSettled:kept:Completed",
			"StepSettled:2-to-3",
			"RunFinished",
		]);
		const proseStep = events[1];
		expect(proseStep?._tag === "StepStarted" && proseStep.step.kind).toBe("prose");
		expect(events.at(-1)?.progress.steps).toEqual({ total: 2, finished: 2 });
	});

	it("keeps a replacement in the step of its first replaced action and lists its sources", async () => {
		const [a, b, c, d, x] = [touch("a"), touch("b"), touch("c"), touch("d"), touch("x")];
		const history = History.make({
			versions: [v1, v2, v3],
			migrations: [
				Migration.make("1-to-2", { from: v1, to: v2 })`${a}${b}`,
				Migration.make("2-to-3", { from: v2, to: v3 })`${c}${d}`,
			],
			rules: [Rule.replace("combine", { match: [b, c], replacement: [x] })],
		});
		const { events, observer } = recorder();
		const report = await Executor.runPromise(
			Plan.withRuntimeCoverage(planOf(history, "3.0.0")),
			{
				handlers: [ok(a), ok(x), ok(d)],
				observers: [observer],
			},
		);

		checkInvariants(events, report);
		const started = events[0];
		expect(started?._tag === "RunStarted" && started.steps).toMatchObject([
			{ id: "1-to-2", kind: "execute", absorbs: ["2-to-3"] },
			{ id: "2-to-3", kind: "execute", absorbs: [] },
		]);
		const replacement = events.find(
			(event) => event._tag === "ActionSettled" && event.action.action === "x",
		);
		expect(replacement?._tag === "ActionSettled" && replacement.action).toEqual({
			occurrence: "combine(1-to-2/b+2-to-3/c)/x",
			action: "x",
			kind: "test.touch",
			description: "Touch x",
			migration: "1-to-2",
			direction: "forward",
			step: "1-to-2",
			origin: { _tag: "Replacement", rule: "combine", replaces: ["1-to-2/b", "2-to-3/c"] },
			sources: ["1-to-2", "2-to-3"],
		});
	});

	it("starts and finishes an empty plan without step events", async () => {
		const history = History.make({
			versions: [v1, v2],
			migrations: [Migration.noop("1-to-2", { from: v1, to: v2 })],
		});
		const { events, observer } = recorder();
		const report = await Executor.runPromise(planOf(history, "2.0.0"), {
			observers: [observer],
			runId: "empty",
		});

		checkInvariants(events, report);
		expect(tags(events)).toEqual(["RunStarted", "RunFinished"]);
		expect(events.at(-1)).toMatchObject({
			run: { id: "empty", mode: "execute", from: "1.0.0", to: "2.0.0", route: "1.0.0>2.0.0" },
			progress: { steps: { total: 0, finished: 0 }, actions: { total: 0, finished: 0 } },
			status: "completed",
		});
	});
});

describe("Delivery", () => {
	it.effect("serializes concurrent branches and keeps one running count per occurrence", () =>
		Effect.gen(function* () {
			const [p, q, r] = [touch("p"), touch("q"), touch("r")];
			const history = History.make({
				versions: [v1, v2],
				migrations: [
					Migration.make("1-to-2", { from: v1, to: v2 })`${Action.parallel([
						Action.sequence([p, q]),
						r,
					])}`,
				],
			});
			const { events, observer } = recorder();
			const fiber = yield* Effect.forkChild(
				Executor.effect(planOf(history, "2.0.0"), {
					handlers: [
						sleeps(p, "1 second"),
						sleeps(q, "1 second"),
						sleeps(r, "3 seconds"),
					],
					observers: [observer],
				}),
			);
			yield* TestClock.adjust("5 seconds");
			const report = yield* Fiber.join(fiber);

			checkInvariants(events, report);
			// The running count belongs to the occurrence, so it holds between its phases.
			expect(
				tags(events).map(
					(tag, index) =>
						`${tag} running=${events[index]?.progress.actions.running} at=${events[index]?.timestamp}`,
				),
			).toEqual([
				"RunStarted running=0 at=0",
				"StepStarted:1-to-2 running=0 at=0",
				"ActionPhaseStarted:p:precondition running=1 at=0",
				"ActionPhaseStarted:p:body running=1 at=0",
				"ActionPhaseStarted:r:precondition running=2 at=0",
				"ActionPhaseStarted:r:body running=2 at=0",
				"ActionSettled:p:Completed running=1 at=1000",
				"ActionPhaseStarted:q:precondition running=2 at=1000",
				"ActionPhaseStarted:q:body running=2 at=1000",
				"ActionSettled:q:Completed running=1 at=2000",
				"ActionSettled:r:Completed running=0 at=3000",
				"StepSettled:1-to-2 running=0 at=3000",
				"RunFinished running=0 at=3000",
			]);
		}),
	);

	it.effect("waits for each observer before the run continues", () =>
		Effect.gen(function* () {
			const a = touch("a");
			const history = History.make({
				versions: [v1, v2],
				migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${a}`],
			});
			const order: Array<string> = [];
			const slow = Observer.effect((event) =>
				event._tag === "StepStarted"
					? Effect.andThen(
							Effect.sleep("1 minute"),
							Effect.sync(() => order.push("observed")),
						)
					: Effect.void,
			);
			const fiber = yield* Effect.forkChild(
				Executor.effect(planOf(history, "2.0.0"), {
					handlers: [Handler.effect(a, () => Effect.sync(() => order.push("body")))],
					observers: [slow],
				}),
			);
			yield* TestClock.adjust("30 seconds");
			expect(order).toEqual([]);
			yield* TestClock.adjust("30 seconds");
			yield* Fiber.join(fiber);
			expect(order).toEqual(["observed", "body"]);
		}),
	);

	it("records observer failures without changing outcomes and keeps delivering", async () => {
		const [a, b] = [touch("a"), touch("b")];
		const history = History.make({
			versions: [v1, v2],
			migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${a}${b}`],
		});
		const { events, observer } = recorder();
		let received = 0;
		const report = await Executor.runPromise(planOf(history, "2.0.0"), {
			handlers: [ok(a), ok(b)],
			observers: [
				Observer.sync((event) => {
					if (event._tag === "RunStarted") throw new Error("broken stream");
				}),
				Observer.promise(async (event) => {
					received += 1;
					if (event._tag === "ActionSettled") throw new Error("rejected");
				}),
				Observer.effect((event) =>
					event._tag === "RunFinished" ? Effect.fail("typed") : Effect.void,
				),
				// A Promise returned to Observer.sync is a misuse, reported as a failure.
				Observer.sync(async () => {}),
				observer,
			],
		});

		expect(report.status).toBe("completed");
		expect(report.occurrences.map((entry) => entry.outcome._tag)).toEqual([
			"Completed",
			"Completed",
		]);
		checkInvariants(events, report);
		expect(received).toBe(events.length);
		expect(
			report.observation
				.filter((failure) => failure.observer !== 3)
				.map((failure) => [failure.observer, failure.event, failure.reason]),
		).toEqual([
			[0, "RunStarted", "failed"],
			[1, "ActionSettled", "failed"],
			[1, "ActionSettled", "failed"],
			[2, "RunFinished", "failed"],
		]);
		expect(report.observation.filter((failure) => failure.observer === 3)).toHaveLength(
			events.length,
		);
	});

	it("emits nothing when handler coverage fails", async () => {
		const a = touch("a");
		const history = History.make({
			versions: [v1, v2],
			migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${a}`],
		});
		const { events, observer } = recorder();
		const error: unknown = await Executor.runPromise(
			Plan.withRuntimeCoverage(planOf(history, "2.0.0")),
			{ observers: [observer] },
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Executor.HandlerCoverageError);
		expect(events).toEqual([]);
	});
});

describe("Outcomes in events", () => {
	it("reports a failed run with step counts and no events for unreached steps", async () => {
		const [checked, fails, later] = [touch("checked"), touch("fails"), touch("later")];
		const history = History.make({
			versions: [v1, v2, v3],
			migrations: [
				Migration.make("1-to-2", { from: v1, to: v2 })`${checked}${fails}`,
				Migration.make("2-to-3", { from: v2, to: v3 })`${later}`,
			],
		});
		const { events, observer } = recorder();
		const error: unknown = await Executor.runPromise(planOf(history, "3.0.0"), {
			handlers: [
				Handler.effect(checked, () => Effect.void, {
					when: () => Effect.succeed(false),
					skipReason: "Nothing to rename",
				}),
				Handler.promise(fails, async () => {
					throw new Error("disk full");
				}),
				ok(later),
			],
			observers: [observer],
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Executor.ExecutionFailed);
		if (!(error instanceof Executor.ExecutionFailed)) return;
		checkInvariants(events, error.report);
		expect(tags(events)).toEqual([
			"RunStarted",
			"StepStarted:1-to-2",
			"ActionPhaseStarted:checked:precondition",
			"ActionSettled:checked:Skipped",
			"ActionPhaseStarted:fails:body",
			"ActionSettled:fails:Failed",
			"StepSettled:1-to-2",
			"RunFinished",
		]);
		const failed = events[5];
		expect(failed?._tag === "ActionSettled" && failed.outcome).toEqual({
			_tag: "Failed",
			phase: "body",
			errorTag: "UnexpectedHandlerError",
		});
		expect(events[6]).toMatchObject({
			counts: { Skipped: 1, Failed: 1, Unattempted: 0 },
			progress: { steps: { total: 2, finished: 1 }, actions: { total: 3, finished: 2 } },
		});
		expect(events[7]).toMatchObject({ status: "failed", counts: { Unattempted: 1 } });
	});

	it("emits dry-run outcomes without body phases", async () => {
		const [checked, unchecked] = [touch("checked"), touch("unchecked")];
		const history = History.make({
			versions: [v1, v2],
			migrations: [Migration.make("1-to-2", { from: v1, to: v2 })`${checked}${unchecked}`],
		});
		const { events, observer } = recorder();
		let bodies = 0;
		const report = await Executor.runPromise(planOf(history, "2.0.0"), {
			dryRun: true,
			handlers: [
				Handler.promise(checked, async () => void (bodies += 1), {
					when: async () => true,
				}),
				Handler.promise(unchecked, async () => void (bodies += 1), {
					when: async () => true,
				}),
			],
			observers: [observer],
		});

		expect(bodies).toBe(0);
		checkInvariants(events, report);
		expect(tags(events)).toEqual([
			"RunStarted",
			"StepStarted:1-to-2",
			"ActionPhaseStarted:checked:precondition",
			"ActionSettled:checked:WouldExecute",
			"ActionSettled:unchecked:Undetermined",
			"StepSettled:1-to-2",
			"RunFinished",
		]);
		expect(events.every((event) => event.run.mode === "dry-run")).toBe(true);
		expect(events.at(-1)).toMatchObject({ status: "would-complete" });
	});
});

describe("Cancellation", () => {
	it("bounds deliveries after cancellation and records abandoned observers", async () => {
		const [cooperative, stubborn] = [touch("cooperative"), touch("stubborn")];
		const history = History.make({
			versions: [v1, v2],
			migrations: [
				Migration.make("1-to-2", { from: v1, to: v2 })`${Action.parallel([
					cooperative,
					stubborn,
				])}`,
			],
		});
		const controller = new AbortController();
		const { events, observer } = recorder();
		let aborted = 0;
		const hanging = Observer.promise(
			(_event, { signal }) =>
				new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => (aborted += 1));
					// Delivery has no limit before cancellation.
					if (!controller.signal.aborted) resolve();
				}),
		);
		let started = 0;
		const start = () => {
			started += 1;
			if (started === 2) controller.abort();
		};
		const error: unknown = await Executor.runPromise(planOf(history, "2.0.0"), {
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
			],
			observers: [hanging, observer],
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Executor.ExecutionInterrupted);
		if (!(error instanceof Executor.ExecutionInterrupted)) return;
		checkInvariants(events, error.report);
		const settled = events.flatMap((event) =>
			event._tag === "ActionSettled" ? [[event.action.action, event.outcome]] : [],
		);
		expect(settled).toEqual([
			[
				"cooperative",
				{ _tag: "Interrupted", phase: "body", reason: "cancelled", settled: true },
			],
			[
				"stubborn",
				{ _tag: "Interrupted", phase: "body", reason: "cancelled", settled: false },
			],
		]);
		expect(events.at(-1)).toMatchObject({
			status: "interrupted",
			counts: { Interrupted: 2, unsettled: 1 },
		});
		const abandoned = error.report.observation.filter(
			(failure) => failure.observer === 0 && failure.reason === "abandoned",
		);
		expect(abandoned.map((failure) => failure.event)).toEqual([
			"ActionSettled",
			"ActionSettled",
			"StepSettled",
			"RunFinished",
		]);
		expect(aborted).toBe(abandoned.length);
	});

	it.effect("sends a report-less RunFinished when the execution fiber is interrupted", () =>
		Effect.gen(function* () {
			const [done, hangs, never] = [touch("done"), touch("hangs"), touch("never")];
			const history = History.make({
				versions: [v1, v2, v3],
				migrations: [
					Migration.make("1-to-2", { from: v1, to: v2 })`${done}${hangs}`,
					Migration.make("2-to-3", { from: v2, to: v3 })`${never}`,
				],
			});
			const { events, observer } = recorder();
			const fiber = yield* Effect.forkChild(
				Executor.effect(planOf(history, "3.0.0"), {
					handlers: [ok(done), Handler.effect(hangs, () => Effect.never), ok(never)],
					observers: [observer],
				}),
			);
			yield* TestClock.adjust("1 second");
			yield* Fiber.interrupt(fiber);

			checkInvariants(events);
			expect(events.at(-1)).toMatchObject({
				_tag: "RunFinished",
				status: "interrupted",
				report: false,
				counts: { Completed: 1, Interrupted: 1, unsettled: 1, Unattempted: 1 },
			});
		}),
	);
});

describe("Manual handlers", () => {
	const [prepare, rotate, finish] = [touch("prepare"), touch("rotate"), touch("finish")];
	const history = History.make({
		versions: [v1, v2, v3],
		migrations: [
			Migration.make("1-to-2", { from: v1, to: v2 })`${prepare}${rotate}`,
			Migration.make("2-to-3", { from: v2, to: v3 })`${finish}`,
		],
	});
	const plan = planOf(history, "3.0.0");

	it("shows waiting as the confirmation phase and summarizes manual completion", async () => {
		const { events, observer } = recorder();
		const report = await Executor.runPromise(plan, {
			handlers: [
				ok(prepare),
				Handler.manual(rotate, { verify: async () => true }),
				ok(finish),
			],
			interaction: answering("confirmed"),
			observers: [observer],
		});

		checkInvariants(events, report);
		expect(tags(events).slice(4, 8)).toEqual([
			"ActionPhaseStarted:rotate:confirmation",
			"ActionPhaseStarted:rotate:verification",
			"ActionSettled:rotate:Completed",
			"StepSettled:1-to-2",
		]);
		const settled = events.flatMap((event) =>
			event._tag === "ActionSettled" ? [event.outcome] : [],
		);
		expect(settled).toEqual([
			{ _tag: "Completed", performer: "automated" },
			{ _tag: "Completed", performer: "manual", confirmation: "verified" },
			{ _tag: "Completed", performer: "automated" },
		]);
	});

	it("reports a decline, stops admission, and counts it", async () => {
		const { events, observer } = recorder();
		const error: unknown = await Executor.runPromise(plan, {
			handlers: [ok(prepare), Handler.manual(rotate), ok(finish)],
			interaction: answering("declined"),
			observers: [observer],
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Executor.ExecutionFailed);
		if (!(error instanceof Executor.ExecutionFailed)) return;
		checkInvariants(events, error.report);
		const declined = events.find(
			(event) => event._tag === "ActionSettled" && event.action.action === "rotate",
		);
		expect(declined?._tag === "ActionSettled" && declined.outcome).toEqual({
			_tag: "Declined",
		});
		expect(events.at(-1)).toMatchObject({
			status: "failed",
			counts: { Completed: 1, Declined: 1, Unattempted: 1 },
		});
	});

	it("emits nothing when no interaction can answer", async () => {
		const { events, observer } = recorder();
		const error: unknown = await Executor.runPromise(plan, {
			handlers: [ok(prepare), Handler.manual(rotate), ok(finish)],
			observers: [observer],
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Executor.InteractionUnavailable);
		expect(events).toEqual([]);
	});

	it("reports manual performers in a dry run without asking", async () => {
		const { events, observer } = recorder();
		let asked = 0;
		const report = await Executor.runPromise(plan, {
			dryRun: true,
			handlers: [
				Handler.effect(prepare, () => Effect.void, { when: () => Effect.succeed(true) }),
				Handler.manual(rotate),
				ok(finish),
			],
			interaction: Interaction.promise(async () => {
				asked += 1;

				return "confirmed";
			}),
			observers: [observer],
		});

		expect(asked).toBe(0);
		checkInvariants(events, report);
		expect(
			events.flatMap((event) =>
				event._tag === "ActionPhaseStarted"
					? [`${event.action.action}:${event.phase}`]
					: [],
			),
		).toEqual(["prepare:precondition"]);
		expect(
			events.flatMap((event) => (event._tag === "ActionSettled" ? [event.outcome] : [])),
		).toEqual([
			{ _tag: "WouldExecute", evaluated: true, performer: "automated" },
			{ _tag: "WouldExecute", evaluated: false, performer: "manual" },
			{ _tag: "WouldExecute", evaluated: false, performer: "automated" },
		]);
	});

	it("settles a cancelled confirmation as interrupted in its phase", async () => {
		const controller = new AbortController();
		const { events, observer } = recorder();
		const error: unknown = await Executor.runPromise(plan, {
			signal: controller.signal,
			handlers: [ok(prepare), Handler.manual(rotate), ok(finish)],
			interaction: Interaction.promise(
				(_request, { signal }) =>
					new Promise<Interaction.Answer>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
						controller.abort();
					}),
			),
			observers: [observer],
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Executor.ExecutionInterrupted);
		if (!(error instanceof Executor.ExecutionInterrupted)) return;
		checkInvariants(events, error.report);
		const interrupted = events.find(
			(event) => event._tag === "ActionSettled" && event.action.action === "rotate",
		);
		expect(interrupted?._tag === "ActionSettled" && interrupted.outcome).toEqual({
			_tag: "Interrupted",
			phase: "confirmation",
			reason: "cancelled",
			settled: true,
		});
	});

	it("composes handler, interaction, and observer services", () => {
		const Terminal = Context.Service<{ readonly ask: () => Effect.Effect<boolean> }>(
			"test/Terminal",
		);
		type Terminal = Context.Service.Identifier<typeof Terminal>;
		const Log = Context.Service<{ readonly line: (text: string) => Effect.Effect<void> }>(
			"test/Log",
		);
		type Log = Context.Service.Identifier<typeof Log>;
		const interaction = Interaction.effect(() =>
			Effect.flatMap(Effect.service(Terminal), (terminal) =>
				Effect.map(terminal.ask(), (yes) => (yes ? "confirmed" : "declined")),
			),
		);
		const logging = Observer.effect((event) =>
			Effect.flatMap(Effect.service(Log), (log) => log.line(event._tag)),
		);
		const execution = Executor.effect(plan, {
			handlers: [ok(prepare), Handler.manual(rotate), ok(finish)],
			interaction,
			observers: [logging],
		});

		expectTypeOf<Effect.Services<typeof execution>>().toEqualTypeOf<Terminal | Log>();
		expectTypeOf<
			Executor.Requirements<never, typeof interaction, typeof logging>
		>().toEqualTypeOf<Terminal | Log>();
	});
});
