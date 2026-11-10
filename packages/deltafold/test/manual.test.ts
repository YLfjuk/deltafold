import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
	Action,
	Executor,
	Handler,
	History,
	Interaction,
	Migration,
	Plan,
	Version,
} from "deltafold";

const RotateKey = Action.define<{ readonly service: string }>("keys.rotate", {
	describe: ({ service }) => `Rotate the ${service} API key`,
});
const Touch = Action.define<{ readonly name: string }>("test.touch", {
	describe: ({ name }) => `Touch ${name}`,
});
const touch = <const Id extends string>(id: Id) => Touch.make(id, { name: id });

const rotate = RotateKey.make("rotate-billing-key", { service: "billing" });
const before = touch("before");
const after = touch("after");

const v1 = Version.make("1.0.0", { changes: [] });
const v2 = Version.make("2.0.0", { previous: v1, changes: [] });
const v3 = Version.make("3.0.0", { previous: v2, changes: [] });

const planOf = <A extends Action.Any>(history: History.History<A>, to = "3.0.0") => {
	const result = History.resolve(history, { from: "1.0.0", to });
	if (Result.isFailure(result)) throw result.failure;

	return result.success;
};

/** `before`, then the manual-capable `rotate` with its own instruction, then `after`. */
const history = History.make({
	versions: [v1, v2, v3],
	migrations: [
		Migration.make("1-to-2", { from: v1, to: v2 })`
			${before}
			${Migration.instruction(rotate)`Rotate the billing key in the dashboard.`}
		`,
		Migration.make("2-to-3", { from: v2, to: v3 })`${after}`,
	],
});
const plan = planOf(history);

const KeyStore = Context.Service<{ readonly isFresh: (service: string) => Promise<boolean> }>(
	"test/KeyStore",
);
type KeyStore = Context.Service.Identifier<typeof KeyStore>;

const Terminal = Context.Service<{ readonly ask: (question: string) => Promise<boolean> }>(
	"test/Terminal",
);
type Terminal = Context.Service.Identifier<typeof Terminal>;

class PromptClosed extends Schema.TaggedError<PromptClosed>()("PromptClosed", {}) {}

const outcomes = (report: Executor.Report) =>
	Object.fromEntries(
		report.occurrences.map((entry) => [entry.occurrence.action.id, entry.outcome]),
	);

const recording = (events: Array<string>) => (action: Action.Any) =>
	Handler.effect(action, () => Effect.sync(() => events.push(action.id)));

const answering = (answer: Interaction.Answer, events: Array<string> = []) =>
	Interaction.effect(({ occurrence }) =>
		Effect.sync(() => {
			events.push(`ask:${occurrence.action.id}`);

			return answer;
		}),
	);

const rejection = <T>(promise: Promise<T>): Promise<unknown> =>
	promise.then(
		() => undefined,
		(cause: unknown) => cause,
	);

const typeOnly = (_check: () => void) => {};

const checks = (strict: boolean): Handler.ManualOptions<{ readonly service: string }, {}, []> =>
	strict ? { verify: () => false } : {};

describe("Manual handler typing", () => {
	it("keeps a bare manual handler free of errors and services", () => {
		const handler = Handler.manual(rotate);

		expectTypeOf(handler.action).toEqualTypeOf(rotate);
		expectTypeOf<Handler.Error<typeof handler>>().toEqualTypeOf<never>();
		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<never>();
	});

	it("infers payloads, services, and errors of Promise checks", () => {
		const skipping = Handler.manual(rotate, { when: ({ service }) => service === "billing" });
		const handler = Handler.manual(rotate, {
			services: { keys: KeyStore },
			errors: [PromptClosed],
			verify: (payload, { keys, signal }) => {
				expectTypeOf(payload).toEqualTypeOf<{ readonly service: string }>();
				expectTypeOf(signal).toEqualTypeOf<AbortSignal>();

				return keys.isFresh(payload.service);
			},
		});

		expectTypeOf<
			Handler.Error<typeof skipping>
		>().toEqualTypeOf<Handler.UnexpectedHandlerError>();
		expectTypeOf<Handler.Error<typeof handler>>().toEqualTypeOf<
			PromptClosed | Handler.UnexpectedHandlerError | Handler.VerificationFailed
		>();
		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<KeyStore>();
	});

	it("keeps native Effect errors and services of Effect checks", () => {
		const handler = Handler.manualEffect(rotate, {
			when: () => Effect.succeed(true),
			verify: ({ service }) =>
				Effect.gen(function* () {
					const keys = yield* KeyStore;
					if (service === "") return yield* new PromptClosed();

					return yield* Effect.promise(() => keys.isFresh(service));
				}),
		});
		const bare = Handler.manualEffect(rotate);

		expectTypeOf<Handler.Error<typeof handler>>().toEqualTypeOf<
			PromptClosed | Handler.VerificationFailed
		>();
		expectTypeOf<Handler.Services<typeof handler>>().toEqualTypeOf<KeyStore>();
		expectTypeOf<Handler.Error<typeof bare>>().toEqualTypeOf<never>();
	});

	it("keeps the errors of checks that annotated or factory-made options may hold", () => {
		const options: Handler.ManualEffectOptions<
			{ readonly service: string },
			never,
			never,
			never,
			never
		> = { verify: () => Effect.succeed(false) };
		const annotated = Handler.manualEffect(rotate, options);
		const produced = Handler.manual(rotate, checks(true));

		expectTypeOf<Handler.Error<typeof annotated>>().toEqualTypeOf<Handler.VerificationFailed>();
		expectTypeOf<Handler.Error<typeof produced>>().toEqualTypeOf<
			Handler.UnexpectedHandlerError | Handler.VerificationFailed
		>();
	});

	it("adds the interaction's errors and services to an ordinary handler array", () => {
		const handlers = [
			Handler.promise(before, async () => {}),
			Handler.manual(rotate, {
				services: { keys: KeyStore },
				verify: ({ service }, { keys }) => keys.isFresh(service),
			}),
			Handler.effect(after, () => Effect.void),
		];
		const interaction = Interaction.promise(
			async ({ occurrence }, { terminal }) =>
				(await terminal.ask(occurrence.action.description)) ? "confirmed" : "declined",
			{ services: { terminal: Terminal }, errors: [PromptClosed] },
		);
		const execution = Executor.effect(plan, { handlers, interaction });

		expectTypeOf<Effect.Services<typeof execution>>().toEqualTypeOf<KeyStore | Terminal>();
		expectTypeOf<
			Executor.Errors<(typeof handlers)[number], typeof interaction>
		>().toEqualTypeOf<
			| Handler.UnexpectedHandlerError
			| Handler.VerificationFailed
			| PromptClosed
			| Interaction.UnexpectedInteractionError
		>();
		expectTypeOf<
			Interaction.Error<ReturnType<typeof answering>>
		>().toEqualTypeOf<Interaction.UnexpectedInteractionError>();
	});

	it("rejects invalid manual declarations", () => {
		expect.assertions(0);

		// @ts-expect-error a check returns a boolean.
		Handler.manual(rotate, { verify: () => "yes" });

		Handler.manual(rotate, {
			// @ts-expect-error `signal` is reserved for the AbortSignal.
			services: { signal: KeyStore },
		});

		// @ts-expect-error a manual handler has no body.
		Handler.manual(rotate, async () => {});

		// @ts-expect-error the only answers are "confirmed" and "declined".
		Interaction.promise(async () => true);

		typeOnly(() => {
			// A manual handler covers its action like any other, and never covers the rest.
			// @ts-expect-error `before` and `after` have no handler.
			Executor.effect(plan, { handlers: [Handler.manual(rotate)] });
			const interaction = Interaction.promise(async () => "confirmed", {
				services: { terminal: Terminal },
			});
			// @ts-expect-error the interaction's Terminal service is missing.
			void Executor.runPromise(Plan.withRuntimeCoverage(plan), {
				handlers: [Handler.manual(rotate)],
				interaction,
			});
		});
	});
});

describe("Manual handlers", () => {
	it.effect("lets one action be manual in one run and automated in another", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const record = recording(events);
			const requests: Array<Interaction.Request> = [];
			const interaction = Interaction.effect((request) =>
				Effect.sync(() => {
					requests.push(request);
					events.push("ask");

					return "confirmed" as const;
				}),
			);

			const local = yield* Executor.effect(plan, {
				handlers: [record(before), Handler.manual(rotate), record(after)],
				interaction,
			});
			const automated = yield* Executor.effect(plan, {
				handlers: [record(before), record(rotate), record(after)],
				interaction,
			});

			expect(events).toEqual([
				"before",
				"ask",
				"after",
				"before",
				"rotate-billing-key",
				"after",
			]);
			expect(local.status).toBe("completed");
			expect(outcomes(local)).toEqual({
				before: { _tag: "Completed", performer: "automated" },
				"rotate-billing-key": {
					_tag: "Completed",
					performer: "manual",
					confirmation: "asserted",
				},
				after: { _tag: "Completed", performer: "automated" },
			});
			expect(outcomes(automated)["rotate-billing-key"]).toEqual({
				_tag: "Completed",
				performer: "automated",
			});
			// The request is the plan's occurrence, with the migration's own instruction.
			expect(requests).toHaveLength(1);
			expect(requests[0]?.occurrence).toBe(plan.occurrences[1]);
			expect(requests[0]?.occurrence.instruction?.content).toEqual([
				{ _tag: "Text", text: "Rotate the billing key in the dashboard." },
			]);
		}),
	);

	it.effect("fails before any work when no interaction is available", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const record = recording(events);
			const error = yield* Effect.flip(
				Executor.effect(plan, {
					handlers: [
						record(before),
						Handler.manual(rotate, {
							// A manual occurrence that would be skipped still needs an interaction.
							when: () => {
								events.push("when");

								return false;
							},
						}),
						record(after),
					],
				}),
			);

			expect(events).toEqual([]);
			expect(error._tag).toBe("InteractionUnavailable");
			if (error._tag !== "InteractionUnavailable") return;
			expect(error.occurrences.map((occurrence) => occurrence.id)).toEqual([
				"1-to-2/rotate-billing-key",
			]);
			expect(error.report).toMatchObject({ status: "not-started", bodiesStarted: false });
			expect(error.message).toContain("Rotate the billing API key");
		}),
	);

	it.effect("never treats a missing handler as manual work", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const error = yield* Effect.flip(
				Executor.effect(Plan.withRuntimeCoverage(plan), {
					handlers: [recording(events)(before), recording(events)(after)],
					interaction: answering("confirmed", events),
				}),
			);

			expect(events).toEqual([]);
			expect(error._tag).toBe("HandlerCoverageError");
			if (error._tag !== "HandlerCoverageError") return;
			expect(error.issues.map((issue) => [issue._tag, issue.actionId])).toEqual([
				["Missing", "rotate-billing-key"],
			]);
		}),
	);

	it.effect("skips without asking when the precondition is false", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const record = recording(events);
			const result = yield* Executor.effect(plan, {
				handlers: [
					record(before),
					Handler.manual(rotate, {
						when: () => false,
						skipReason: ({ service }) => `The ${service} key is not in use`,
						verify: () => {
							events.push("verify");

							return true;
						},
					}),
					record(after),
				],
				interaction: answering("confirmed", events),
			});

			expect(events).toEqual(["before", "after"]);
			expect(outcomes(result)["rotate-billing-key"]).toEqual({
				_tag: "Skipped",
				reason: "The billing key is not in use",
			});
		}),
	);

	it.effect("verifies only after the person confirms", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const record = recording(events);
			const result = yield* Executor.effect(plan, {
				handlers: [
					record(before),
					Handler.manual(rotate, {
						services: { keys: KeyStore },
						verify: ({ service }, { keys }) => {
							events.push("verify");

							return keys.isFresh(service);
						},
					}),
					record(after),
				],
				interaction: answering("confirmed", events),
			}).pipe(Effect.provideService(KeyStore, { isFresh: async () => true }));

			expect(events).toEqual(["before", "ask:rotate-billing-key", "verify", "after"]);
			expect(outcomes(result)["rotate-billing-key"]).toEqual({
				_tag: "Completed",
				performer: "manual",
				confirmation: "verified",
			});
		}),
	);

	it.effect("fails a confirmed occurrence whose verification does not pass", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const record = recording(events);
			const error = yield* Effect.flip(
				Executor.effect(plan, {
					handlers: [
						record(before),
						Handler.manualEffect(rotate, { verify: () => Effect.succeed(false) }),
						record(after),
					],
					interaction: answering("confirmed", events),
				}),
			);

			expect(events).toEqual(["before", "ask:rotate-billing-key"]);
			expect(error._tag).toBe("ExecutionFailed");
			if (error._tag !== "ExecutionFailed") return;
			expect(error.declined).toEqual([]);
			expect(error.failures.map((failure) => failure.occurrence.id)).toEqual([
				"1-to-2/rotate-billing-key",
			]);
			const [failure] = error.failures;
			expect(failure?.outcome).toMatchObject({ _tag: "Failed", phase: "verification" });
			expect(failure?.outcome._tag === "Failed" && failure.outcome.error).toBeInstanceOf(
				Handler.VerificationFailed,
			);
			expect(outcomes(error.report).after).toEqual({ _tag: "Unattempted" });
		}),
	);

	it.effect("stops the run when the person declines, without verifying", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const record = recording(events);
			const error = yield* Effect.flip(
				Executor.effect(plan, {
					handlers: [
						record(before),
						Handler.manual(rotate, {
							verify: () => {
								events.push("verify");

								return true;
							},
						}),
						record(after),
					],
					interaction: answering("declined", events),
				}),
			);

			expect(events).toEqual(["before", "ask:rotate-billing-key"]);
			expect(error._tag).toBe("ExecutionFailed");
			if (error._tag !== "ExecutionFailed") return;
			expect(error.failures).toEqual([]);
			expect(error.declined.map((entry) => entry.occurrence.id)).toEqual([
				"1-to-2/rotate-billing-key",
			]);
			expect(error.message).toContain("Manual work was declined");
			expect(error.report).toMatchObject({ status: "failed", bodiesStarted: true });
			expect(outcomes(error.report)).toEqual({
				before: { _tag: "Completed", performer: "automated" },
				"rotate-billing-key": { _tag: "Declined" },
				after: { _tag: "Unattempted" },
			});
		}),
	);

	it.effect("never asks or verifies in a dry run, and needs no interaction", () =>
		Effect.gen(function* () {
			const events: Array<string> = [];
			const record = recording(events);
			const handlers = [
				record(before),
				Handler.manual(rotate, {
					verify: () => {
						events.push("verify");

						return true;
					},
				}),
				record(after),
			];
			const unattended = yield* Executor.effect(plan, { handlers, dryRun: true });
			const attended = yield* Executor.effect(plan, {
				handlers,
				dryRun: true,
				interaction: answering("confirmed", events),
			});

			expect(events).toEqual([]);
			expect(unattended.status).toBe("would-complete");
			expect(outcomes(unattended)).toEqual({
				before: { _tag: "WouldExecute", evaluated: false, performer: "automated" },
				"rotate-billing-key": {
					_tag: "WouldExecute",
					evaluated: false,
					performer: "manual",
				},
				after: { _tag: "WouldExecute", evaluated: false, performer: "automated" },
			});
			expect(outcomes(attended)).toEqual(outcomes(unattended));
		}),
	);

	it.effect("never applies the timeout to the wait for a person", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				Executor.effect(Plan.withRuntimeCoverage(plan), {
					timeout: "1 second",
					handlers: [
						Handler.manual(rotate),
						Handler.effect(before, () => Effect.void),
						Handler.effect(after, () => Effect.void),
					],
					interaction: Interaction.effect(() =>
						Effect.as(Effect.sleep("1 hour"), "confirmed" as const),
					),
				}),
			);
			yield* TestClock.adjust("1 hour");
			const result = yield* Fiber.join(fiber);

			expect(result.status).toBe("completed");
		}),
	);

	it.effect("applies the timeout to verification", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				Effect.flip(
					Executor.effect(Plan.withRuntimeCoverage(plan), {
						timeout: "1 second",
						handlers: [
							Handler.manualEffect(rotate, {
								verify: () => Effect.as(Effect.sleep("1 hour"), true),
							}),
							Handler.effect(before, () => Effect.void),
							Handler.effect(after, () => Effect.void),
						],
						interaction: answering("confirmed"),
					}),
				),
			);
			yield* TestClock.adjust("1 second");
			const error = yield* Fiber.join(fiber);

			expect(error._tag).toBe("ExecutionInterrupted");
			if (error._tag !== "ExecutionInterrupted") return;
			expect(error.reason).toBe("timeout");
			expect(outcomes(error.report)["rotate-billing-key"]).toEqual({
				_tag: "Interrupted",
				phase: "verification",
				reason: "timeout",
				settled: true,
			});
		}),
	);

	it("ends the wait on cancellation and tells the interaction to stop", async () => {
		const controller = new AbortController();
		let aborted = false;
		const error = await rejection(
			Executor.runPromise(plan, {
				signal: controller.signal,
				handlers: [
					Handler.promise(before, async () => {}),
					Handler.manual(rotate),
					Handler.promise(after, async () => {}),
				],
				// A prompt that the person closes cancels the run and never answers.
				interaction: Interaction.promise(
					(_request, { signal }) =>
						new Promise<Interaction.Answer>((_resolve, reject) => {
							signal.addEventListener("abort", () => {
								aborted = true;
								reject(signal.reason);
							});
							controller.abort();
						}),
				),
			}),
		);

		expect(aborted).toBe(true);
		expect(error).toBeInstanceOf(Executor.ExecutionInterrupted);
		if (!(error instanceof Executor.ExecutionInterrupted)) return;
		expect(error.reason).toBe("cancelled");
		expect(outcomes(error.report)).toEqual({
			before: { _tag: "Completed", performer: "automated" },
			"rotate-billing-key": {
				_tag: "Interrupted",
				phase: "confirmation",
				reason: "cancelled",
				settled: true,
			},
			after: { _tag: "Unattempted" },
		});
	});

	it("reports an interaction that ignores cancellation as not settled", async () => {
		const controller = new AbortController();
		const error = await rejection(
			Executor.runPromise(plan, {
				signal: controller.signal,
				settleTimeout: "20 millis",
				handlers: [
					Handler.promise(before, async () => {}),
					Handler.manual(rotate),
					Handler.promise(after, async () => {}),
				],
				interaction: Interaction.promise(() => {
					controller.abort();

					return new Promise<Interaction.Answer>(() => {});
				}),
			}),
		);

		expect(
			error instanceof Executor.ExecutionInterrupted &&
				outcomes(error.report)["rotate-billing-key"],
		).toEqual({
			_tag: "Interrupted",
			phase: "confirmation",
			reason: "cancelled",
			settled: false,
		});
	});

	it("does not ask when cancellation arrives during the precondition", async () => {
		const controller = new AbortController();
		let asked = false;
		const error = await rejection(
			Executor.runPromise(plan, {
				signal: controller.signal,
				handlers: [
					Handler.promise(before, async () => {}),
					Handler.manual(rotate, {
						when: () => {
							controller.abort();

							return true;
						},
					}),
					Handler.promise(after, async () => {}),
				],
				interaction: Interaction.promise(async () => {
					asked = true;

					return "confirmed";
				}),
			}),
		);

		expect(asked).toBe(false);
		expect(error).toBeInstanceOf(Executor.ExecutionInterrupted);
	});

	it("does not verify when cancellation follows a sibling failure", async () => {
		const fails = touch("fails");
		const confirmed = touch("confirmed");
		const controller = new AbortController();
		let verifiedWork = false;
		let prompted = () => {};
		const asked = new Promise<void>((resolve) => {
			prompted = resolve;
		});
		const error = await rejection(
			Executor.runPromise(
				planOf(
					History.make({
						versions: [v1, v2],
						migrations: [
							Migration.make("1-to-2", {
								from: v1,
								to: v2,
							})`${Action.parallel([fails, confirmed])}`,
						],
					}),
					"2.0.0",
				),
				{
					signal: controller.signal,
					handlers: [
						Handler.promise(fails, async () => {
							await asked;
							throw new Error("disk full");
						}),
						Handler.manual(confirmed, {
							verify: () => {
								verifiedWork = true;

								return true;
							},
						}),
					],
					// The sibling fails while the prompt is open. The person then answers as
					// the run is cancelled.
					interaction: Interaction.promise(async () => {
						prompted();
						for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
						controller.abort();

						return "confirmed";
					}),
				},
			),
		);

		expect(verifiedWork).toBe(false);
		expect(error).toBeInstanceOf(Executor.ExecutionFailed);
		if (!(error instanceof Executor.ExecutionFailed)) return;
		expect(outcomes(error.report).fails).toMatchObject({ _tag: "Failed", phase: "body" });
		// The cancellation can win the race against the answer, or arrive just after it.
		expect(outcomes(error.report).confirmed).toMatchObject({
			_tag: "Interrupted",
			reason: "cancelled",
		});
	});

	it.effect("fails the occurrence when the interaction itself fails", () =>
		Effect.gen(function* () {
			const handlers = [
				Handler.effect(before, () => Effect.void),
				Handler.manual(rotate),
				Handler.effect(after, () => Effect.void),
			];
			const closed = yield* Effect.flip(
				Executor.effect(plan, {
					handlers,
					interaction: Interaction.effect(() => Effect.fail(new PromptClosed())),
				}),
			);
			const thrown = yield* Effect.flip(
				Executor.effect(plan, {
					handlers,
					interaction: Interaction.promise(async () => {
						throw new Error("stdin closed");
					}),
				}),
			);

			for (const [error, expected] of [
				[closed, PromptClosed],
				[thrown, Interaction.UnexpectedInteractionError],
			] as const) {
				expect(error._tag).toBe("ExecutionFailed");
				if (error._tag !== "ExecutionFailed") continue;
				const outcome = outcomes(error.report)["rotate-billing-key"];
				expect(outcome).toMatchObject({ _tag: "Failed", phase: "confirmation" });
				expect(outcome?._tag === "Failed" && outcome.error).toBeInstanceOf(expected);
			}
		}),
	);

	it.effect("never completes on, or keeps, an answer other than a confirmation", () =>
		Effect.gen(function* () {
			// An untyped caller answers with the text that the person typed.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			const typed = "yes, the token is abc123" as Interaction.Answer;
			const handlers = [
				Handler.effect(before, () => Effect.void),
				Handler.manual(rotate),
				Handler.effect(after, () => Effect.void),
			];

			for (const interaction of [
				Interaction.promise(async () => typed),
				Interaction.effect(() => Effect.succeed(typed)),
			]) {
				const error = yield* Effect.flip(Executor.effect(plan, { handlers, interaction }));

				expect(error._tag).toBe("ExecutionFailed");
				if (error._tag !== "ExecutionFailed") continue;
				const outcome = outcomes(error.report)["rotate-billing-key"];
				expect(outcome).toMatchObject({ _tag: "Failed", phase: "confirmation" });
				expect(outcome?._tag === "Failed" && outcome.error).toMatchObject({
					_tag: "UnexpectedInteractionError",
					reason: "invalid-answer",
					cause: undefined,
				});
				expect(JSON.stringify(outcome)).not.toContain("abc123");
				expect(outcomes(error.report).after).toEqual({ _tag: "Unattempted" });
			}
		}),
	);

	it.effect("asks parallel branches concurrently and lets a sibling settle after a decline", () =>
		Effect.gen(function* () {
			const first = touch("first");
			const second = touch("second");
			const later = touch("later");
			const parallel = planOf(
				History.make({
					versions: [v1, v2, v3],
					migrations: [
						Migration.make("1-to-2", {
							from: v1,
							to: v2,
						})`${Action.parallel([first, second])}`,
						Migration.make("2-to-3", { from: v2, to: v3 })`${later}`,
					],
				}),
			);
			const asked: Array<string> = [];
			const bothAsked = yield* Deferred.make<void>();
			const error = yield* Effect.flip(
				Executor.effect(parallel, {
					handlers: [
						Handler.manual(first),
						Handler.manual(second),
						Handler.effect(later, () => Effect.void),
					],
					interaction: Interaction.effect(({ occurrence }) =>
						Effect.gen(function* () {
							asked.push(occurrence.action.id);
							if (asked.length === 2) yield* Deferred.succeed(bothAsked, undefined);
							// Neither prompt is answered until both are open.
							yield* Deferred.await(bothAsked);
							if (occurrence.action.id === "first") return "declined" as const;
							// The sibling answers after the decline stopped admission.
							yield* Effect.yieldNow;

							return "confirmed" as const;
						}),
					),
				}),
			);

			expect(new Set(asked)).toEqual(new Set(["first", "second"]));
			expect(error._tag).toBe("ExecutionFailed");
			if (error._tag !== "ExecutionFailed") return;
			expect(outcomes(error.report)).toEqual({
				first: { _tag: "Declined" },
				second: { _tag: "Completed", performer: "manual", confirmation: "asserted" },
				later: { _tag: "Unattempted" },
			});
		}),
	);
});
