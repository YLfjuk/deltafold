import {
	Cause,
	Context,
	Data,
	Deferred,
	Duration,
	Effect,
	Equal,
	Exit,
	Fiber,
	Layer,
	Option,
	Scope,
} from "effect";

import type * as Action from "../../foundation/action.ts";
import type * as Plan from "../../foundation/plan.ts";
import type { Node, Occurrence } from "../../foundation/plan.ts";
import * as Handler from "./handler.ts";
import { SettlementReference } from "./settlement.ts";

/**
 * What happened to one occurrence, or what a dry run predicts.
 *
 * @since @next
 */
export type Outcome<E = unknown> =
	| { readonly _tag: "Completed" }
	| { readonly _tag: "Skipped"; readonly reason: string }
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
			/** `handler`: an Effect handler interrupted itself. */
			readonly reason: InterruptReason;
			/**
			 * Whether the interrupted work is known to have stopped. An interrupted Promise
			 * that has not settled within the grace period may still be changing external
			 * state.
			 */
			readonly settled: boolean;
	  }
	/** Not started because execution stopped first. */
	| { readonly _tag: "Unattempted" }
	/** `evaluated`: whether a prepare phase ran and decided to apply. */
	| { readonly _tag: "WouldExecute"; readonly evaluated: boolean }
	| { readonly _tag: "WouldSkip"; readonly reason: string }
	| { readonly _tag: "Undetermined"; readonly reason: string }
	| {
			readonly _tag: "PreparationFailed";
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
	 * Whether any apply phase started. A started apply phase may have partially changed
	 * state.
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
 * Handler coverage failed before any handler phase ran. Every occurrence needs exactly
 * one handler, for the same action definition: the same identifier, kind, and payload.
 * For an occurrence that a rule produced, the issue names the rule and the occurrences
 * it replaced.
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

const ExecutionFailedBase = Data.TaggedError("ExecutionFailed");

/**
 * An occurrence failed. Execution stopped admitting new actions; started ones settled.
 *
 * @since @next
 */
export class ExecutionFailed<
	A extends Action.Any = Action.Any,
	E = unknown,
> extends ExecutionFailedBase<{
	readonly failures: ReadonlyArray<OccurrenceReport<A, E>>;
	readonly report: Report<A, E>;
}> {
	override get message() {
		return `Execution failed at ${this.failures
			.map((failure) => `"${failure.occurrence.id}"`)
			.join(", ")}. Completed actions were not rolled back.`;
	}
}

const ExecutionInterruptedBase = Data.TaggedError("ExecutionInterrupted");

/**
 * Why an execution or an occurrence was interrupted: explicit cancellation, a configured
 * timeout, or an Effect handler that interrupted itself.
 *
 * @since @next
 */
export type InterruptReason = "cancelled" | "timeout" | "handler";

const interruptedBy: Record<InterruptReason, string> = {
	cancelled: "cancelled",
	timeout: "stopped by a timeout",
	handler: "interrupted by a handler",
};

/**
 * Explicit cancellation, a configured timeout, or a handler's own interruption stopped
 * execution.
 *
 * @since @next
 */
export class ExecutionInterrupted<
	A extends Action.Any = Action.Any,
	E = unknown,
> extends ExecutionInterruptedBase<{
	readonly reason: InterruptReason;
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

		return `Execution was ${interruptedBy[this.reason]}.${suffix}`;
	}
}

/** @since @next */
export type ExecutionError<A extends Action.Any, E> =
	| HandlerCoverageError<A>
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
export type Errors<H> = Handler.Error<H>;

/**
 * Effect services an execution requires: the services of its handlers.
 *
 * @since @next
 */
export type Requirements<H> = Handler.Services<H>;

/** @since @next */
export type Options<H extends Handler.Any> = {
	readonly handlers?: ReadonlyArray<H>;
	/**
	 * Run prepare phases without running any apply phase. A prepare phase that may
	 * depend on an earlier action is reported `Undetermined`, because the dry run does
	 * not apply that action.
	 */
	readonly dryRun?: boolean;
	/**
	 * Limit for each phase of an occurrence: the prepare phase and the apply phase each
	 * get the full limit. Exceeding it interrupts that action and stops admitting new
	 * ones. It applies to dry-run prepare phases too.
	 */
	readonly timeout?: Duration.Input;
	/**
	 * How long to wait for an interrupted Promise callback to settle before reporting it
	 * as possibly still running. Defaults to 5 seconds.
	 */
	readonly settleTimeout?: Duration.Input;
};

/** A handler as the executor runs it: its action is erased, its channels are not. */
type Internal<E, R> = Handler.Handler<Action.Any, E, R>;

type Resolved<E, R> = Map<string, Internal<E, R>>;

const describeReplaces = (occurrence: Occurrence) =>
	occurrence.origin._tag === "Replacement"
		? occurrence.origin.replaces.map((replaced) => ({
				occurrenceId: replaced.id,
				description: replaced.action.description,
			}))
		: [];

const coverage = <E, R>(
	plan: Plan.Any,
	handlers: ReadonlyArray<Internal<E, R>>,
): { readonly resolved: Resolved<E, R>; readonly issues: ReadonlyArray<CoverageIssue> } => {
	const byAction = new Map<string, Array<Internal<E, R>>>();
	for (const handler of handlers) {
		const list = byAction.get(handler.action.id) ?? [];
		list.push(handler);
		byAction.set(handler.action.id, list);
	}

	const resolved: Resolved<E, R> = new Map();
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

/** The exit an occurrence's scope closes with, so finalizers see how it ended. */
const exitOf = <E>(outcome: Outcome<E> | undefined): Exit.Exit<void, E> => {
	switch (outcome?._tag) {
		case "Failed":
		case "PreparationFailed":
			return Exit.failCause(outcome.cause);
		case "Interrupted":
			return Exit.interrupt();
		default:
			return Exit.void;
	}
};

const forEachBranch = <R>(
	branches: ReadonlyArray<Node>,
	concurrency: Action.Concurrency,
	run: (node: Node) => Effect.Effect<void, never, R>,
) => Effect.forEach(branches, run, { concurrency, discard: true });

/** Registers a callback that cancels the execution. Only `runPromise` uses it. */
type Subscribe = (cancel: () => void) => void;

/**
 * Receives the fiber that closes an occurrence scope after an interrupted Promise
 * settles, so the caller can keep the services it built open until then.
 */
type Retain = (fiber: Fiber.Fiber<void>) => void;

type StopReason = "failure" | InterruptReason;

type PhaseResult<T, E> =
	| { readonly _tag: "Done"; readonly exit: Exit.Exit<T, E> }
	| {
			readonly _tag: "Interrupted";
			readonly reason: "cancelled" | "timeout";
			readonly settled: boolean;
	  };

type ControlOptions = Pick<Options<never>, "timeout" | "settleTimeout">;

/**
 * Logs a cleanup failure that the report cannot carry, with the occurrence or the
 * services layer that owned the resources.
 */
const logCleanupFailure = (owner: Record<string, string>) => (cause: Cause.Cause<unknown>) =>
	Effect.logError("deltafold: cleanup failed", cause).pipe(Effect.annotateLogs(owner));

/** Admission state, cancellation, and timeouts shared by real and dry runs. */
const makeControl = (options: ControlOptions, subscribe: Subscribe | undefined) =>
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
		 * Runs one phase, racing it against cancellation and its own timeout. An
		 * interrupted Promise that outlives the settlement grace period goes to `unsettled`.
		 */
		const runPhase = <T, E, R>(
			work: Effect.Effect<T, E, R>,
			unsettled: Array<Promise<void>>,
		): Effect.Effect<PhaseResult<T, E>, never, R> =>
			Effect.gen(function* () {
				let settled = true;
				const tracked = work.pipe(
					Effect.provideService(SettlementReference, {
						grace: settleTimeout,
						unsettled: (promise) => {
							settled = false;
							unsettled.push(promise);
						},
					}),
				);
				const stopSignals: Array<Effect.Effect<"cancelled" | "timeout">> = [
					Deferred.await(cancelled),
				];
				if (options.timeout !== undefined) {
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

/**
 * Runs one occurrence in its own scope, which both phases share. `use` returns the
 * exit to close the scope with. The scope closes as soon as the occurrence ends, and
 * a failing finalizer goes to `onCleanupFailure`. If an interrupted Promise has not
 * settled, the scope stays open until it does, possibly forever; a failing
 * finalizer is then logged, because the report may already have been returned.
 */
const inScope = <E, R>(
	retain: Retain,
	occurrenceId: string,
	use: (
		scope: Scope.Scope,
		unsettled: Array<Promise<void>>,
	) => Effect.Effect<Exit.Exit<void, E>, never, R>,
	onCleanupFailure: (cause: Cause.Cause<never>) => Effect.Effect<void>,
): Effect.Effect<void, never, R> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const scope = yield* Scope.make();
			const unsettled: Array<Promise<void>> = [];
			const used = yield* Effect.exit(restore(use(scope, unsettled)));
			const end = Exit.isSuccess(used) ? used.value : used;
			if (unsettled.length > 0) {
				const fiber = yield* Effect.forkDetach(
					Effect.promise(() => Promise.all(unsettled)).pipe(
						Effect.andThen(Scope.close(scope, end)),
						Effect.catchCause(logCleanupFailure({ occurrence: occurrenceId })),
					),
				);
				retain(fiber);
			} else {
				const closed = yield* Effect.exit(Scope.close(scope, end));
				if (Exit.isFailure(closed)) yield* onCleanupFailure(closed.cause);
			}

			return yield* used;
		}),
	).pipe(Effect.asVoid);

const interrupted = <A extends Action.Any, E>(
	plan: Plan.Plan<A, Plan.Coverage>,
	mode: Report["mode"],
	reason: InterruptReason,
	outcomes: ReadonlyMap<string, Outcome<E>>,
	bodiesStarted: boolean,
) =>
	new ExecutionInterrupted({
		reason,
		report: report(plan, mode, "interrupted", outcomes, bodiesStarted),
	});

/**
 * The outcome of a phase that did not succeed. `undefined` when it succeeded. An Effect
 * handler that interrupted itself stops admission.
 */
const unsuccessful = <T, E>(
	phase: Handler.Phase,
	result: PhaseResult<T, E>,
	stop: (reason: StopReason) => void,
): Outcome<E> | undefined => {
	if (result._tag === "Interrupted") {
		return {
			_tag: "Interrupted",
			phase,
			reason: result.reason,
			settled: result.settled,
		};
	}
	if (Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)) {
		stop("handler");

		return { _tag: "Interrupted", phase, reason: "handler", settled: true };
	}

	return undefined;
};

const execute = <A extends Action.Any, E, R>(
	plan: Plan.Plan<A, Plan.Coverage>,
	resolved: Resolved<E, R>,
	options: ControlOptions,
	subscribe: Subscribe | undefined,
	retain: Retain,
): Effect.Effect<Report<A, E>, ExecutionFailed<A, E> | ExecutionInterrupted<A, E>, R> =>
	Effect.gen(function* () {
		const outcomes = new Map<string, Outcome<E>>();
		const { halt, stop, runPhase } = yield* makeControl(options, subscribe);
		let bodiesStarted = false;

		const runOccurrence = (occurrence: Occurrence) => {
			if (halt.reason !== undefined) return Effect.void;

			const handler = resolved.get(occurrence.id);
			if (handler === undefined) return Effect.void;

			let phase: Handler.Phase = "prepare";
			const end = (outcome: Outcome<E>) => {
				outcomes.set(occurrence.id, outcome);

				return exitOf(outcome);
			};
			const fail = (cause: Cause.Cause<E>) => {
				stop("failure");

				return end({ _tag: "Failed", phase, ...failureOf(cause) });
			};

			const use = (scope: Scope.Scope, unsettled: Array<Promise<void>>) =>
				Effect.gen(function* () {
					let step: Handler.Step<E, R>;
					if (handler.prepares) {
						const preparation = yield* runPhase(handler.prepare(scope), unsettled);
						const stopped = unsuccessful("prepare", preparation, stop);
						if (stopped !== undefined) return end(stopped);
						if (preparation._tag !== "Done") return Exit.void;
						if (Exit.isFailure(preparation.exit)) return fail(preparation.exit.cause);
						step = preparation.exit.value;
						// The occurrence has started, so a sibling failure or timeout lets it
						// finish. Cancellation that arrived while preparing keeps it from
						// applying, and the prepared value is discarded.
						if (step._tag === "Apply" && halt.reason === "cancelled") return Exit.void;
					} else {
						const started = yield* Effect.exit(handler.prepare(scope));
						if (Exit.isFailure(started)) return fail(started.cause);
						step = started.value;
					}
					if (step._tag === "Skip") return end({ _tag: "Skipped", reason: step.reason });

					phase = "apply";
					bodiesStarted = true;
					const applied = yield* runPhase(step.apply, unsettled);
					const stopped = unsuccessful("apply", applied, stop);
					if (stopped !== undefined) return end(stopped);
					if (applied._tag !== "Done") return Exit.void;
					if (Exit.isFailure(applied.exit)) return fail(applied.exit.cause);

					return end({ _tag: "Completed" });
				});

			// A finalizer that fails before the report is part of the execution: it fails an
			// occurrence that otherwise ended normally. An interrupted occurrence keeps its
			// outcome, and the failure is logged.
			const onCleanupFailure = (cause: Cause.Cause<never>) =>
				Effect.suspend(() => {
					const outcome = outcomes.get(occurrence.id);
					if (outcome?._tag === "Interrupted") {
						return logCleanupFailure({ occurrence: occurrence.id })(cause);
					}
					stop("failure");
					outcomes.set(occurrence.id, {
						_tag: "Failed",
						phase,
						...failureOf(
							outcome?._tag === "Failed"
								? Cause.combine(outcome.cause, cause)
								: cause,
						),
					});

					return Effect.void;
				});

			return inScope(retain, occurrence.id, use, onCleanupFailure);
		};

		const runNode = (node: Node): Effect.Effect<void, never, R> => {
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
				report: result,
			});
		}

		return yield* interrupted(plan, "execute", halt.reason, outcomes, bodiesStarted);
	});

const dryRun = <A extends Action.Any, E, R>(
	plan: Plan.Plan<A, Plan.Coverage>,
	resolved: Resolved<E, R>,
	options: ControlOptions,
	subscribe: Subscribe | undefined,
	retain: Retain,
): Effect.Effect<Report<A, E>, ExecutionInterrupted<A, E>, R> =>
	Effect.gen(function* () {
		const outcomes = new Map<string, Outcome<E>>();
		const { halt, stop, runPhase } = yield* makeControl(options, subscribe);
		let failedAt: string | undefined;

		/** Runs a prepare phase in the occurrence's scope and records what it predicts. */
		const prepare = (id: string, handler: Internal<E, R>) => {
			const end = (outcome: Outcome<E>) => {
				outcomes.set(id, outcome);

				return exitOf(outcome);
			};
			const use = (scope: Scope.Scope, unsettled: Array<Promise<void>>) =>
				Effect.gen(function* () {
					const preparation = yield* runPhase(handler.prepare(scope), unsettled);
					const stopped = unsuccessful("prepare", preparation, stop);
					if (stopped !== undefined) return end(stopped);
					if (preparation._tag !== "Done") return Exit.void;
					if (Exit.isFailure(preparation.exit)) {
						failedAt = id;

						return end({
							_tag: "PreparationFailed",
							...failureOf(preparation.exit.cause),
						});
					}
					// A dry run never applies: the prepared value is discarded.
					const step = preparation.exit.value;

					return end(
						step._tag === "Skip"
							? { _tag: "WouldSkip", reason: step.reason }
							: { _tag: "WouldExecute", evaluated: true },
					);
				});
			const onCleanupFailure = (cause: Cause.Cause<never>) =>
				Effect.suspend(() => {
					const outcome = outcomes.get(id);
					if (outcome?._tag === "Interrupted") {
						return logCleanupFailure({ occurrence: id })(cause);
					}
					failedAt ??= id;
					outcomes.set(id, {
						_tag: "PreparationFailed",
						...failureOf(
							outcome?._tag === "PreparationFailed"
								? Cause.combine(outcome.cause, cause)
								: cause,
						),
					});

					return Effect.void;
				});

			return inScope(retain, id, use, onCleanupFailure);
		};

		/** Returns whether the node would or might change state. */
		const visit = (node: Node, dirty: boolean): Effect.Effect<boolean, never, R> =>
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
						reason: `Execution would stop at the failed preparation of "${failedAt}".`,
					});

					return true;
				}
				if (!handler.prepares) {
					outcomes.set(node.id, { _tag: "WouldExecute", evaluated: false });

					return true;
				}
				if (dirty) {
					outcomes.set(node.id, {
						_tag: "Undetermined",
						reason: "The prepare phase depends on earlier actions that a dry run does not apply.",
					});

					return true;
				}

				yield* prepare(node.id, handler);

				return outcomes.get(node.id)?._tag !== "WouldSkip";
			});

		// Later migrations conservatively depend on every earlier migration.
		let dirty = false;
		for (const step of plan.steps) dirty = yield* visit(step.node, dirty);

		if (halt.reason !== undefined && halt.reason !== "failure") {
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

const run = <A extends Action.Any, C extends Plan.Coverage, H extends Handler.Any>(
	plan: Plan.Plan<A, C>,
	options: Options<H>,
	subscribe: Subscribe | undefined,
	retain: Retain,
): Effect.Effect<Report<A, Errors<H>>, ExecutionError<A, Errors<H>>, Requirements<H>> => {
	// Handlers are covariant in their errors and services, and `Errors<H>` and
	// `Requirements<H>` collect them from each handler in `H`, so every handler fits this
	// shape. From here on the compiler checks both channels.
	const handlers: ReadonlyArray<Internal<Errors<H>, Requirements<H>>> = options.handlers ?? [];

	return Effect.gen(function* () {
		const checked = coverage(plan, handlers);
		if (checked.issues.length > 0) {
			return yield* new HandlerCoverageError({
				issues: checked.issues,
				report: report(
					plan,
					options.dryRun === true ? "dry-run" : "execute",
					"not-started",
					new Map<string, Outcome<never>>(),
					false,
				),
			});
		}

		return options.dryRun === true
			? yield* dryRun(plan, checked.resolved, options, subscribe, retain)
			: yield* execute(plan, checked.resolved, options, subscribe, retain);
	});
};

/**
 * Runs a plan as an Effect. Coverage is checked before any handler phase runs. Steps
 * are sequential barriers; parallel groups run their branches concurrently. On failure,
 * no new action starts, and actions already running settle before the effect fails
 * with the partial report.
 *
 * Each occurrence has its own scope, shared by its phases and closed when it ends. An
 * interrupted Promise that has not settled keeps its occurrence's scope open until it
 * settles, after the effect has ended. Services that the caller provides stay the
 * caller's to release.
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
>(
	plan: Plan.Plan<A, C>,
	options: Options<H> & CoverageCheck<A, H, C>,
): Effect.Effect<Report<A, Errors<H>>, ExecutionError<A, Errors<H>>, Requirements<H>> =>
	run(plan, options, undefined, () => {});

type ServicesOption<R, LE> = [R] extends [never]
	? {
			/** Handlers without Effect services need none. */
			readonly services?: Context.Context<never> | Layer.Layer<never, LE>;
		}
	: {
			/** Supplies the handlers' Effect services. */
			readonly services: Context.Context<R> | Layer.Layer<R, LE>;
		};

/** @since @next */
export type PromiseOptions<H extends Handler.Any> = Options<H> & {
	/**
	 * Explicit cancellation. Aborting stops admission, interrupts running actions, and
	 * rejects with `ExecutionInterrupted` and the partial report.
	 */
	readonly signal?: AbortSignal;
};

/**
 * Runs a plan and returns a Promise. It rejects with `HandlerCoverageError`,
 * `ExecutionFailed`, or `ExecutionInterrupted`, each carrying the partial report.
 * Building a supplied services layer can also reject with the layer's own error,
 * without a report.
 *
 * A services layer is built for this run. A services context stays owned by the
 * caller. A Promise callback that ignores its signal can keep running after
 * cancellation or a timeout, beyond `settleTimeout`; the report marks it as possibly
 * still running. Its occurrence's scope and the run's services layer then stay open
 * until it settles, possibly forever, and close in that order. A cleanup failure after
 * the Promise resolved is logged through Effect.
 *
 * @since @next
 */
export const runPromise = <
	A extends Action.Any,
	C extends Plan.Coverage,
	H extends Handler.Any = never,
	LE = never,
>(
	plan: Plan.Plan<A, C>,
	options: PromiseOptions<H> & ServicesOption<Requirements<H>, LE> & CoverageCheck<A, H, C>,
): Promise<Report<A, Errors<H>>> => {
	const { signal } = options;
	const notStarted = () =>
		new ExecutionInterrupted({
			reason: "cancelled",
			report: report(
				plan,
				options.dryRun === true ? "dry-run" : "execute",
				"interrupted",
				new Map<string, Outcome<Errors<H>>>(),
				false,
			),
		});
	if (signal?.aborted === true) return Promise.reject(notStarted());

	// Until the run installs its own cancellation, an abort stops building the services
	// layer. Afterwards the run stops admission and reports partial progress.
	const abortedBeforeRun = Deferred.makeUnsafe<void>();
	let cancelRun: (() => void) | undefined;
	const onAbort = () => {
		if (cancelRun === undefined) Deferred.doneUnsafe(abortedBeforeRun, Effect.void);
		else cancelRun();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const subscribe: Subscribe | undefined =
		signal === undefined
			? undefined
			: (cancel) => {
					cancelRun = cancel;
					if (signal.aborted) cancel();
				};
	const retained: Array<Fiber.Fiber<void>> = [];
	const program = run(plan, options, subscribe, (fiber) => retained.push(fiber));
	const services: Context.Context<never> | Layer.Layer<never, LE> | undefined = options.services;
	const provided =
		services === undefined
			? program
			: Context.isContext(services)
				? Effect.provideContext(program, services)
				: // runPromise is the entry point: the caller's layer is built for this one run,
					// in a scope that outlives the run while retained occurrence scopes are open.
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							const scope = yield* Scope.make();
							const built = yield* Effect.exit(
								restore(Layer.buildWithScope(services, scope)),
							);
							if (Exit.isFailure(built)) {
								yield* Scope.close(scope, built);

								return yield* built;
							}
							const exit = yield* Effect.exit(
								restore(Effect.provideContext(program, built.value)),
							);
							if (retained.length === 0) yield* Scope.close(scope, exit);
							else {
								yield* Effect.forkDetach(
									Fiber.awaitAll(retained).pipe(
										Effect.andThen(Scope.close(scope, exit)),
										Effect.catchCause(
											logCleanupFailure({ owner: "services layer" }),
										),
									),
								);
							}

							return yield* exit;
						}),
					);
	const cancellable =
		signal === undefined
			? provided
			: Effect.raceFirst(
					provided,
					Effect.andThen(Deferred.await(abortedBeforeRun), Effect.fail(notStarted())),
				);

	return Effect.runPromiseExit(
		// `ServicesOption` requires services that cover every requirement. A layer that
		// fails to build rejects with its own error.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion, effecttsgo/unsafe-effect-type-assertion
		cancellable as Effect.Effect<Report<A, Errors<H>>, ExecutionError<A, Errors<H>> | LE>,
	)
		.finally(() => signal?.removeEventListener("abort", onAbort))
		.then((exit) => {
			if (Exit.isSuccess(exit)) return exit.value;

			throw Cause.squash(exit.cause);
		});
};
