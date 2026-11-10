import {
	Cause,
	Context,
	Data,
	Deferred,
	Duration,
	Effect,
	Equal,
	Exit,
	Layer,
	Option,
} from "effect";

import type * as Action from "../../foundation/action.ts";
import type * as Plan from "../../foundation/plan.ts";
import type { Node, Occurrence } from "../../foundation/plan.ts";
import * as Handler from "./handler.ts";
import type * as Interaction from "./interaction.ts";
import { SettlementReference } from "./settlement.ts";

/**
 * What happened to one occurrence, or what a dry run predicts.
 *
 * @since @next
 */
export type Outcome<E = unknown> =
	| { readonly _tag: "Completed"; readonly performer: "automated" }
	| {
			readonly _tag: "Completed";
			readonly performer: "manual";
			/**
			 * What supports completion: `asserted` is the person's confirmation alone, and
			 * `verified` means the handler's `verify` check also passed. Neither proves
			 * how the work was done.
			 */
			readonly confirmation: "asserted" | "verified";
	  }
	| { readonly _tag: "Skipped"; readonly reason: string }
	/** The person asked to confirm manual work answered that it is not done. */
	| { readonly _tag: "Declined" }
	| {
			readonly _tag: "Failed";
			readonly phase: Handler.Phase;
			/** The typed failure, when the cause has one. Defects only appear in `cause`. */
			readonly error: E | undefined;
			readonly cause: Cause.Cause<E>;
	  }
	| {
			readonly _tag: "Interrupted";
			readonly phase: Handler.Phase;
			readonly reason: "cancelled" | "timeout";
			/**
			 * Whether the interrupted work is known to have stopped. An interrupted Promise
			 * that has not settled within the grace period may still be changing external
			 * state.
			 */
			readonly settled: boolean;
	  }
	/** Not started because execution stopped first. */
	| { readonly _tag: "Unattempted" }
	| {
			readonly _tag: "WouldExecute";
			readonly evaluated: boolean;
			/** `manual` occurrences would wait for a person. A dry run never asks. */
			readonly performer: Handler.Performer;
	  }
	| { readonly _tag: "WouldSkip"; readonly reason: string }
	| { readonly _tag: "Undetermined"; readonly reason: string }
	| {
			readonly _tag: "PreconditionFailed";
			readonly error: E | undefined;
			readonly cause: Cause.Cause<E>;
	  };

/** @since @next */
export type OccurrenceReport<A extends Action.Any = Action.Any, E = unknown> = {
	readonly occurrence: Occurrence<A>;
	readonly outcome: Outcome<E>;
};

/** @since @next */
export type Report<A extends Action.Any = Action.Any, E = unknown> = {
	readonly _tag: "Report";
	readonly mode: "execute" | "dry-run";
	readonly status:
		| "completed"
		| "failed"
		| "interrupted"
		| "not-started"
		| "would-complete"
		| "would-fail";
	readonly from: string;
	readonly to: string;
	readonly route: string;
	/** Every occurrence in plan order. */
	readonly occurrences: ReadonlyArray<OccurrenceReport<A, E>>;
	/**
	 * Whether any action body started or any person was asked to do manual work. Either
	 * may have partially changed state.
	 */
	readonly bodiesStarted: boolean;
	/** Progress is not persisted. Rerunning the plan repeats completed actions. */
	readonly persistence: "none";
};

/**
 * A handler is missing, duplicated, or bound to a different definition.
 *
 * @since @next
 */
export type CoverageIssue = {
	readonly _tag: "Missing" | "Duplicate" | "Mismatched";
	readonly occurrenceId: string;
	readonly actionId: string;
	readonly description: string;
	readonly migrationId: string;
	/** The rule that produced the occurrence, for replacements. */
	readonly rule: string | undefined;
	/** The occurrences a replacement stands for, so the missing handler is discoverable. */
	readonly replaces: ReadonlyArray<{
		readonly occurrenceId: string;
		readonly description: string;
	}>;
};

const HandlerCoverageBase = Data.TaggedError("HandlerCoverageError");

/**
 * Handler coverage failed before any precondition or body ran.
 *
 * @since @next
 */
export class HandlerCoverageError<A extends Action.Any = Action.Any> extends HandlerCoverageBase<{
	readonly issues: ReadonlyArray<CoverageIssue>;
	readonly report: Report<A, never>;
}> {
	override get message() {
		return `Handler coverage failed for ${this.issues.length} occurrence(s): ${this.issues
			.map(
				(issue) =>
					`${issue._tag.toLowerCase()} handler for "${issue.actionId}" (${issue.description})`,
			)
			.join("; ")}.`;
	}
}

const InteractionUnavailableBase = Data.TaggedError("InteractionUnavailable");

/**
 * The plan has manual handlers, and the run has no `interaction` to ask a person. The
 * run fails before any precondition, body, or prompt.
 *
 * @since @next
 */
export class InteractionUnavailable<
	A extends Action.Any = Action.Any,
> extends InteractionUnavailableBase<{
	/** The occurrences that a manual handler covers, in plan order. */
	readonly occurrences: ReadonlyArray<Occurrence<A>>;
	readonly report: Report<A, never>;
}> {
	override get message() {
		return `No interaction is available to confirm manual work for ${this.occurrences
			.map((occurrence) => `"${occurrence.id}" (${occurrence.action.description})`)
			.join(
				", ",
			)}. Supply the \`interaction\` option, or bind automated handlers to these actions.`;
	}
}

const listIds = (entries: ReadonlyArray<OccurrenceReport>) =>
	entries.map((entry) => `"${entry.occurrence.id}"`).join(", ");

const ExecutionFailedBase = Data.TaggedError("ExecutionFailed");

/**
 * An occurrence failed, or a person declined manual work. Execution stopped admitting
 * new actions; started ones settled.
 *
 * @since @next
 */
export class ExecutionFailed<
	A extends Action.Any = Action.Any,
	E = unknown,
> extends ExecutionFailedBase<{
	readonly failures: ReadonlyArray<OccurrenceReport<A, E>>;
	/** Manual occurrences that a person declined. */
	readonly declined: ReadonlyArray<OccurrenceReport<A, E>>;
	readonly report: Report<A, E>;
}> {
	override get message() {
		const parts = [
			...(this.failures.length === 0
				? []
				: [`Execution failed at ${listIds(this.failures)}.`]),
			...(this.declined.length === 0
				? []
				: [`Manual work was declined at ${listIds(this.declined)}.`]),
		];

		return `${parts.join(" ")} Completed actions were not rolled back.`;
	}
}

const ExecutionInterruptedBase = Data.TaggedError("ExecutionInterrupted");

/**
 * Explicit cancellation or a configured timeout stopped execution.
 *
 * @since @next
 */
export class ExecutionInterrupted<
	A extends Action.Any = Action.Any,
	E = unknown,
> extends ExecutionInterruptedBase<{
	readonly reason: "cancelled" | "timeout";
	readonly report: Report<A, E>;
}> {
	override get message() {
		const pending = this.report.occurrences.filter(
			(entry) => entry.outcome._tag === "Interrupted" && !entry.outcome.settled,
		);
		const suffix =
			pending.length === 0
				? ""
				: ` ${pending.length} interrupted action(s) had not settled and may still be running.`;

		return `Execution was ${this.reason === "cancelled" ? "cancelled" : "stopped by a timeout"}.${suffix}`;
	}
}

/** @since @next */
export type ExecutionError<A extends Action.Any, E> =
	| HandlerCoverageError<A>
	| InteractionUnavailable<A>
	| ExecutionFailed<A, E>
	| ExecutionInterrupted<A, E>;

/**
 * Action identifiers of a statically covered plan that no handler in the array
 * implements.
 *
 * @since @next
 */
export type Uncovered<A extends Action.Any, H, C extends Plan.Coverage> = "runtime" extends C
	? never
	: A extends Action.Any
		? string extends A["id"]
			? never
			: A["id"] extends Handler.ActionId<H>
				? never
				: A["id"]
		: never;

/** Rejects a handler array that leaves statically known actions uncovered, naming them. */
type CoverageCheck<A extends Action.Any, H, C extends Plan.Coverage> = [
	Uncovered<A, H, C>,
] extends [never]
	? unknown
	: { readonly handlers: `Missing a handler for action "${Uncovered<A, H, C>}"` };

/**
 * Errors an execution can report for its occurrences.
 *
 * @since @next
 */
export type Errors<H, I = never> = Handler.Error<H> | Interaction.Error<I>;

/**
 * Effect services an execution requires: the services of its handlers and of its
 * interaction.
 *
 * @since @next
 */
export type Requirements<H, I = never> = Handler.Services<H> | Interaction.Services<I>;

/** @since @next */
export type Options<H extends Handler.Any, I extends Interaction.Any = never> = {
	readonly handlers?: ReadonlyArray<H>;
	/**
	 * Asks a person to confirm the work of manual handlers. A run whose plan has manual
	 * handlers fails with `InteractionUnavailable` before it starts when this is absent.
	 * A dry run never asks and does not need it.
	 */
	readonly interaction?: I;
	/** Evaluate preconditions without running any action body. */
	readonly dryRun?: boolean;
	/**
	 * Per-occurrence limit for a precondition, body, or verification. Exceeding it
	 * interrupts that action and stops admitting new ones. It applies to dry-run
	 * preconditions too. It never limits the wait for a person to confirm manual work;
	 * cancel the run to end that wait.
	 */
	readonly timeout?: Duration.Input;
	/**
	 * How long to wait for an interrupted Promise callback to settle before reporting it
	 * as possibly still running. Defaults to 5 seconds.
	 */
	readonly settleTimeout?: Duration.Input;
};

type Resolved = Map<string, Handler.Any>;

const describeReplaces = (occurrence: Occurrence) =>
	occurrence.origin._tag === "Replacement"
		? occurrence.origin.replaces.map((replaced) => ({
				occurrenceId: replaced.id,
				description: replaced.action.description,
			}))
		: [];

const coverage = (
	plan: Plan.Any,
	handlers: ReadonlyArray<Handler.Any>,
): { readonly resolved: Resolved; readonly issues: ReadonlyArray<CoverageIssue> } => {
	const byAction = new Map<string, Array<Handler.Any>>();
	for (const handler of handlers) {
		const list = byAction.get(handler.action.id) ?? [];
		list.push(handler);
		byAction.set(handler.action.id, list);
	}

	const resolved: Resolved = new Map();
	const issues: Array<CoverageIssue> = [];
	for (const occurrence of plan.occurrences) {
		const issue = (tag: CoverageIssue["_tag"]) =>
			issues.push({
				_tag: tag,
				occurrenceId: occurrence.id,
				actionId: occurrence.action.id,
				description: occurrence.action.description,
				migrationId: occurrence.migration.id,
				rule:
					occurrence.origin._tag === "Replacement"
						? occurrence.origin.rule.id
						: undefined,
				replaces: describeReplaces(occurrence),
			});

		const candidates = byAction.get(occurrence.action.id) ?? [];
		const [selected] = candidates;
		if (candidates.length > 1) issue("Duplicate");
		else if (selected === undefined) issue("Missing");
		else if (
			selected.action.kind !== occurrence.action.kind ||
			!Equal.equals(selected.action.payload, occurrence.action.payload)
		) {
			issue("Mismatched");
		} else resolved.set(occurrence.id, selected);
	}

	return { resolved, issues };
};

const report = <A extends Action.Any, E>(
	plan: Plan.Plan<A, Plan.Coverage>,
	mode: Report["mode"],
	status: Report["status"],
	outcomes: ReadonlyMap<string, Outcome<E>>,
	bodiesStarted: boolean,
): Report<A, E> => ({
	_tag: "Report",
	mode,
	status,
	from: plan.from.id,
	to: plan.to.id,
	route: plan.route.id,
	occurrences: plan.occurrences.map((occurrence) => ({
		occurrence,
		outcome: outcomes.get(occurrence.id) ?? { _tag: "Unattempted" },
	})),
	bodiesStarted,
	persistence: "none",
});

const failureOf = <E>(cause: Cause.Cause<E>) => ({
	error: Option.getOrUndefined(Cause.findErrorOption(cause)),
	cause,
});

const forEachBranch = (
	branches: ReadonlyArray<Node>,
	concurrency: Action.Concurrency,
	run: (node: Node) => Effect.Effect<void, never, any>,
) => Effect.forEach(branches, run, { concurrency, discard: true });

/** Registers a callback that cancels the execution. Only `runPromise` uses it. */
type Subscribe = (cancel: () => void) => void;

type StopReason = "failure" | "cancelled" | "timeout";

type PhaseResult<T> =
	| { readonly _tag: "Done"; readonly exit: Exit.Exit<T, unknown> }
	| {
			readonly _tag: "Interrupted";
			readonly reason: "cancelled" | "timeout";
			readonly settled: boolean;
	  };

/** Admission state, cancellation, and timeouts shared by real and dry runs. */
const makeControl = (
	options: Options<Handler.Any, Interaction.Any>,
	subscribe: Subscribe | undefined,
) =>
	Effect.gen(function* () {
		const halt: { reason: StopReason | undefined } = { reason: undefined };
		const cancelled = yield* Deferred.make<"cancelled">();
		const settleTimeout = options.settleTimeout ?? Duration.seconds(5);

		const stop = (reason: StopReason) => {
			halt.reason ??= reason;
		};
		subscribe?.(() => {
			stop("cancelled");
			Deferred.doneUnsafe(cancelled, Exit.succeed("cancelled"));
		});

		/**
		 * Runs one phase, racing it against cancellation and the timeout. Waiting for a
		 * person is `untimed`: only cancellation ends it.
		 */
		const runPhase = <T>(
			work: Effect.Effect<T, unknown, any>,
			timing: "timed" | "untimed" = "timed",
		): Effect.Effect<PhaseResult<T>, never, any> =>
			Effect.gen(function* () {
				let settled = true;
				const tracked = work.pipe(
					Effect.provideService(SettlementReference, {
						grace: settleTimeout,
						record: (value) => {
							settled = value;
						},
					}),
				);
				const stopSignals: Array<Effect.Effect<"cancelled" | "timeout">> = [
					Deferred.await(cancelled),
				];
				if (options.timeout !== undefined && timing === "timed") {
					stopSignals.push(Effect.as(Effect.sleep(options.timeout), "timeout" as const));
				}
				const result = yield* Effect.raceFirst(
					Effect.map(Effect.exit(tracked), (exit) => ({ _tag: "Done" as const, exit })),
					Effect.raceAll(stopSignals).pipe(
						// Stop admission as soon as the signal fires. The race returns only after
						// the interrupted work has had its settlement grace period.
						Effect.tap((reason) => Effect.sync(() => stop(reason))),
						Effect.map((reason) => ({ _tag: "Stop" as const, reason })),
					),
				);
				if (result._tag === "Done") return result;

				// A timeout interrupts only this action. Siblings settle as after any failure.
				return { _tag: "Interrupted" as const, reason: result.reason, settled };
			});

		return { halt, stop, runPhase };
	});

const interrupted = <A extends Action.Any>(
	plan: Plan.Plan<A, Plan.Coverage>,
	mode: Report["mode"],
	reason: "cancelled" | "timeout",
	outcomes: ReadonlyMap<string, Outcome>,
	bodiesStarted: boolean,
) =>
	new ExecutionInterrupted({
		reason,
		report: report(plan, mode, "interrupted", outcomes, bodiesStarted),
	});

const execute = (
	plan: Plan.Any,
	resolved: Resolved,
	options: Options<Handler.Any, Interaction.Any>,
	subscribe: Subscribe | undefined,
): Effect.Effect<Report, ExecutionFailed | ExecutionInterrupted, any> =>
	Effect.gen(function* () {
		const outcomes = new Map<string, Outcome>();
		const { halt, stop, runPhase } = yield* makeControl(options, subscribe);
		let bodiesStarted = false;

		/** Sets the outcome of a phase that did not succeed, and returns its value otherwise. */
		const settle = <T>(
			occurrence: Occurrence,
			phase: Handler.Phase,
			result: PhaseResult<T>,
		): Option.Option<T> => {
			if (result._tag === "Interrupted") {
				outcomes.set(occurrence.id, {
					_tag: "Interrupted",
					phase,
					reason: result.reason,
					settled: result.settled,
				});

				return Option.none();
			}
			if (Exit.isFailure(result.exit)) {
				stop("failure");
				outcomes.set(occurrence.id, {
					_tag: "Failed",
					phase,
					...failureOf(result.exit.cause),
				});

				return Option.none();
			}

			return Option.some(result.exit.value);
		};

		/** Waits for a person to confirm the work, then runs the handler's verification. */
		const runManual = (
			occurrence: Occurrence,
			handler: Handler.Any,
			interaction: Interaction.Any,
		) =>
			Effect.gen(function* () {
				// The person may start changing state as soon as they are asked.
				bodiesStarted = true;
				const answer = settle(
					occurrence,
					"confirmation",
					yield* runPhase(interaction.confirm({ occurrence }), "untimed"),
				);
				if (Option.isNone(answer)) return;
				if (answer.value === "declined") {
					stop("failure");
					outcomes.set(occurrence.id, { _tag: "Declined" });

					return;
				}
				if (handler.verification === undefined) {
					outcomes.set(occurrence.id, {
						_tag: "Completed",
						performer: "manual",
						confirmation: "asserted",
					});

					return;
				}
				// Cancellation that arrived with the confirmation keeps the check from starting.
				if (halt.reason === "cancelled") {
					outcomes.set(occurrence.id, {
						_tag: "Interrupted",
						phase: "verification",
						reason: "cancelled",
						settled: true,
					});

					return;
				}
				const checked = settle(
					occurrence,
					"verification",
					yield* runPhase(handler.verification),
				);
				if (Option.isNone(checked)) return;
				outcomes.set(occurrence.id, {
					_tag: "Completed",
					performer: "manual",
					confirmation: "verified",
				});
			});

		const runOccurrence = (occurrence: Occurrence) =>
			Effect.gen(function* () {
				if (halt.reason !== undefined) return;

				const handler = resolved.get(occurrence.id);
				if (handler === undefined) return;

				if (handler.precondition !== undefined) {
					const applies = settle(
						occurrence,
						"precondition",
						yield* runPhase(handler.precondition),
					);
					if (Option.isNone(applies)) return;
					if (!applies.value) {
						outcomes.set(occurrence.id, {
							_tag: "Skipped",
							reason: handler.skipReason,
						});

						return;
					}
					// The occurrence has started, so a sibling failure lets it finish.
					// Cancellation that arrived during the precondition keeps the body or the
					// prompt from starting.
					if (halt.reason === "cancelled") return;
				}

				if (handler.performer === "manual") {
					// The interaction preflight guarantees one for every manual occurrence.
					if (options.interaction === undefined) return;

					yield* runManual(occurrence, handler, options.interaction);

					return;
				}

				bodiesStarted = true;
				const ran = settle(occurrence, "body", yield* runPhase(handler.body));
				if (Option.isNone(ran)) return;
				outcomes.set(occurrence.id, { _tag: "Completed", performer: "automated" });
			});

		const runNode = (node: Node): Effect.Effect<void, never, any> => {
			switch (node._tag) {
				case "Occurrence":
					return runOccurrence(node);
				case "Sequence":
					return Effect.forEach(node.children, runNode, { discard: true });
			}

			// Sibling failures stop admission through `halt`; they never interrupt branches.
			return forEachBranch(node.branches, node.concurrency, runNode);
		};

		for (const step of plan.steps) {
			// Migration steps are barriers: a step starts only after the previous one settled.
			if (halt.reason !== undefined) break;
			yield* runNode(step.node);
		}

		if (halt.reason === undefined)
			return report(plan, "execute", "completed", outcomes, bodiesStarted);
		if (halt.reason === "failure") {
			const result = report(plan, "execute", "failed", outcomes, bodiesStarted);

			return yield* new ExecutionFailed({
				failures: result.occurrences.filter((entry) => entry.outcome._tag === "Failed"),
				declined: result.occurrences.filter((entry) => entry.outcome._tag === "Declined"),
				report: result,
			});
		}

		return yield* interrupted(plan, "execute", halt.reason, outcomes, bodiesStarted);
	});

const dryRun = (
	plan: Plan.Any,
	resolved: Resolved,
	options: Options<Handler.Any, Interaction.Any>,
	subscribe: Subscribe | undefined,
): Effect.Effect<Report, ExecutionInterrupted, any> =>
	Effect.gen(function* () {
		const outcomes = new Map<string, Outcome>();
		const { halt, runPhase } = yield* makeControl(options, subscribe);
		let failedAt: string | undefined;

		/** Returns whether the node would or might change state. */
		const visit = (node: Node, dirty: boolean): Effect.Effect<boolean, never, any> =>
			Effect.gen(function* () {
				if (node._tag === "Sequence") {
					let current = dirty;
					for (const child of node.children) current = yield* visit(child, current);

					return current;
				}
				if (node._tag === "Parallel") {
					// Branches are independent: each starts from the state before the group.
					// They are evaluated one at a time so the report is deterministic.
					let changed = dirty;
					for (const branch of node.branches)
						changed = (yield* visit(branch, dirty)) || changed;

					return changed;
				}

				const handler = resolved.get(node.id);
				if (handler === undefined || halt.reason !== undefined) return dirty;
				if (failedAt !== undefined) {
					outcomes.set(node.id, {
						_tag: "Undetermined",
						reason: `Execution would stop at the failed precondition of "${failedAt}".`,
					});

					return true;
				}
				if (handler.precondition === undefined) {
					outcomes.set(node.id, {
						_tag: "WouldExecute",
						evaluated: false,
						performer: handler.performer,
					});

					return true;
				}
				if (dirty) {
					outcomes.set(node.id, {
						_tag: "Undetermined",
						reason: "The precondition depends on earlier actions that a dry run does not apply.",
					});

					return true;
				}

				const checked = yield* runPhase(handler.precondition);
				if (checked._tag === "Interrupted") {
					outcomes.set(node.id, {
						_tag: "Interrupted",
						phase: "precondition",
						reason: checked.reason,
						settled: checked.settled,
					});

					return true;
				}
				if (Exit.isFailure(checked.exit)) {
					failedAt = node.id;
					outcomes.set(node.id, {
						_tag: "PreconditionFailed",
						...failureOf(checked.exit.cause),
					});

					return true;
				}
				if (!checked.exit.value) {
					outcomes.set(node.id, { _tag: "WouldSkip", reason: handler.skipReason });

					return false;
				}
				outcomes.set(node.id, {
					_tag: "WouldExecute",
					evaluated: true,
					performer: handler.performer,
				});

				return true;
			});

		// Later migrations conservatively depend on every earlier migration.
		let dirty = false;
		for (const step of plan.steps) dirty = yield* visit(step.node, dirty);

		if (halt.reason === "cancelled" || halt.reason === "timeout") {
			return yield* interrupted(plan, "dry-run", halt.reason, outcomes, false);
		}

		return report(
			plan,
			"dry-run",
			failedAt === undefined ? "would-complete" : "would-fail",
			outcomes,
			false,
		);
	});

const run = <
	A extends Action.Any,
	C extends Plan.Coverage,
	H extends Handler.Any,
	I extends Interaction.Any,
>(
	plan: Plan.Plan<A, C>,
	options: Options<H, I>,
	subscribe: Subscribe | undefined,
): Effect.Effect<Report<A, Errors<H, I>>, ExecutionError<A, Errors<H, I>>, Requirements<H, I>> =>
	// The plan's action union and the handler union determine these types; the
	// implementation works on erased handlers.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	Effect.gen(function* () {
		const checked = coverage(plan, options.handlers ?? []);
		if (checked.issues.length > 0) {
			return yield* new HandlerCoverageError({
				issues: checked.issues,
				report: report(
					plan,
					options.dryRun === true ? "dry-run" : "execute",
					"not-started",
					new Map(),
					false,
				),
			});
		}

		if (options.dryRun === true) {
			return yield* dryRun(plan, checked.resolved, options, subscribe);
		}

		// Nobody can answer for manual work, so the run must not start and stop halfway.
		const manual = plan.occurrences.filter(
			(occurrence) => checked.resolved.get(occurrence.id)?.performer === "manual",
		);
		if (manual.length > 0 && options.interaction === undefined) {
			return yield* new InteractionUnavailable({
				occurrences: manual,
				report: report(plan, "execute", "not-started", new Map(), false),
			});
		}

		return yield* execute(plan, checked.resolved, options, subscribe);
	}) as Effect.Effect<
		Report<A, Errors<H, I>>,
		ExecutionError<A, Errors<H, I>>,
		Requirements<H, I>
	>;

/**
 * Runs a plan as an Effect. Coverage, and the interaction that manual handlers need,
 * are checked before any precondition or body runs.
 * Steps are sequential barriers; parallel groups run their branches concurrently. On
 * failure, no new action starts, and actions already running settle before the effect
 * fails with the partial report.
 *
 * To cancel, interrupt the fiber. Interruption reaches running actions and aborts the
 * signal passed to Promise callbacks. The effect then ends as interrupted, without a
 * report.
 *
 * @since @next
 */
export const effect = <
	A extends Action.Any,
	C extends Plan.Coverage,
	H extends Handler.Any = never,
	I extends Interaction.Any = never,
>(
	plan: Plan.Plan<A, C>,
	options: Options<H, I> & CoverageCheck<A, H, C>,
): Effect.Effect<Report<A, Errors<H, I>>, ExecutionError<A, Errors<H, I>>, Requirements<H, I>> =>
	run(plan, options, undefined);

type ServicesOption<R> = [R] extends [never]
	? {
			/** Handlers and interactions without Effect services need none. */
			readonly services?: Context.Context<never> | Layer.Layer<never, unknown>;
		}
	: {
			/** Supplies the Effect services of the handlers and the interaction. */
			readonly services: Context.Context<R> | Layer.Layer<R, unknown>;
		};

/** @since @next */
export type PromiseOptions<H extends Handler.Any, I extends Interaction.Any = never> = Options<
	H,
	I
> & {
	/**
	 * Explicit cancellation. Aborting stops admission, interrupts running actions and
	 * pending confirmations, and rejects with `ExecutionInterrupted` and the partial
	 * report.
	 */
	readonly signal?: AbortSignal;
};

/**
 * Runs a plan and returns a Promise. It rejects with `HandlerCoverageError`,
 * `InteractionUnavailable`, `ExecutionFailed`, or `ExecutionInterrupted`, each carrying
 * the partial report.
 * Building a supplied services layer can also reject with the layer's own error,
 * without a report.
 *
 * @since @next
 */
export const runPromise = <
	A extends Action.Any,
	C extends Plan.Coverage,
	H extends Handler.Any = never,
	I extends Interaction.Any = never,
>(
	plan: Plan.Plan<A, C>,
	options: PromiseOptions<H, I> & ServicesOption<Requirements<H, I>> & CoverageCheck<A, H, C>,
): Promise<Report<A, Errors<H, I>>> => {
	const { signal } = options;
	let unsubscribe: (() => void) | undefined;
	const subscribe: Subscribe | undefined =
		signal === undefined
			? undefined
			: (cancel) => {
					if (signal.aborted) {
						cancel();

						return;
					}
					signal.addEventListener("abort", cancel, { once: true });
					unsubscribe = () => signal.removeEventListener("abort", cancel);
				};
	const program = run(plan, options, subscribe);
	const services: Context.Context<never> | Layer.Layer<never, unknown> | undefined =
		options.services;
	const provided =
		services === undefined
			? program
			: Context.isContext(services)
				? Effect.provideContext(program, services)
				: Effect.provide(program, services);

	return Effect.runPromiseExit(
		// `ServicesOption` requires services that cover every requirement.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		provided as Effect.Effect<Report<A, Errors<H, I>>, unknown>,
	)
		.finally(() => unsubscribe?.())
		.then((exit) => {
			if (Exit.isSuccess(exit)) return exit.value;

			throw Cause.squash(exit.cause);
		});
};
