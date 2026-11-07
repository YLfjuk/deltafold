/**
 * Executors run plans with handlers. Both executors accept the same mixed collection of
 * Promise, Effect, and integration-produced handlers.
 *
 * @packageDocumentation
 */
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

import type * as Action from "./action.ts";
import * as Handler from "./handler.ts";
import { SettlementReference } from "./internal/settlement.ts";
import type { Node, Occurrence, Plan } from "./plan.ts";

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
	| { readonly _tag: "WouldExecute"; readonly evaluated: boolean }
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
	/** Whether any action body started. A started body may have partially changed state. */
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
	| ExecutionFailed<A, E>
	| ExecutionInterrupted<A, E>;

/** Action identifiers that the handler array leaves to `Handler.layer` bindings. */
type Uncovered<A extends Action.Any, H> = A extends Action.Any
	? string extends A["id"]
		? never
		: A["id"] extends Handler.ActionId<H>
			? never
			: A["id"]
	: never;

type Bindings<Id> = Id extends string ? Handler.Binding<Id> : never;

/** True when some occurrence may be served by a binding looked up at run time. */
type UsesBindings<A extends Action.Any, H> = [Uncovered<A, H>] extends [never]
	? string extends A["id"]
		? true
		: false
	: true;

/**
 * Errors an execution can report for its occurrences.
 *
 * @since @next
 */
export type Errors<A extends Action.Any, H> =
	| Handler.Error<H>
	| (UsesBindings<A, H> extends true ? Handler.BoundHandlerError : never);

/**
 * Effect services an execution requires: the handlers' services, plus a
 * `Handler.Binding` for every statically known action the handler array does not cover.
 *
 * @since @next
 */
export type Requirements<A extends Action.Any, H> = Handler.Services<H> | Bindings<Uncovered<A, H>>;

/** @since @next */
export type Options<H extends Handler.Any> = {
	readonly handlers?: ReadonlyArray<H>;
	/** Evaluate preconditions without running any action body. */
	readonly dryRun?: boolean;
	/** Explicit cancellation. Aborting interrupts in-flight actions and stops execution. */
	readonly signal?: AbortSignal;
	/** Per-occurrence limit for a precondition or body. Exceeding it interrupts the action. */
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
	plan: Plan,
	handlers: ReadonlyArray<Handler.Any>,
	context: Context.Context<never>,
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
		const [handler] = candidates;
		const bound =
			handler === undefined
				? Context.getOrUndefined(context, Handler.bindingKey(occurrence.action.id))
				: undefined;
		const selected = handler ?? bound;
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
	plan: Plan<A>,
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

type Halt = { reason: "failure" | "cancelled" | "timeout" | undefined };

const execute = (
	plan: Plan,
	resolved: Resolved,
	options: Options<Handler.Any>,
): Effect.Effect<Report, ExecutionFailed | ExecutionInterrupted, any> =>
	Effect.gen(function* () {
		const outcomes = new Map<string, Outcome>();
		const halt: Halt = { reason: undefined };
		let bodiesStarted = false;
		const cancelled = yield* Deferred.make<"cancelled">();
		const settleTimeout = options.settleTimeout ?? Duration.seconds(5);

		const stop = (reason: NonNullable<Halt["reason"]>) => {
			halt.reason ??= reason;
		};

		const signal = options.signal;
		const onAbort = () => {
			stop("cancelled");
			Deferred.doneUnsafe(cancelled, Exit.succeed("cancelled"));
		};
		if (signal?.aborted === true) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });

		const runPhase = <T>(
			work: Effect.Effect<T, unknown, any>,
		): Effect.Effect<
			| { readonly _tag: "Done"; readonly exit: Exit.Exit<T, unknown> }
			| {
					readonly _tag: "Interrupted";
					readonly reason: "cancelled" | "timeout";
					readonly settled: boolean;
			  },
			never,
			any
		> =>
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
				if (options.timeout !== undefined) {
					stopSignals.push(Effect.as(Effect.sleep(options.timeout), "timeout" as const));
				}
				const result = yield* Effect.raceFirst(
					Effect.map(Effect.exit(tracked), (exit) => ({ _tag: "Done" as const, exit })),
					Effect.map(Effect.raceAll(stopSignals), (reason) => ({
						_tag: "Stop" as const,
						reason,
					})),
				);
				if (result._tag === "Done") return result;

				// A timeout interrupts only this action. Siblings settle as after any failure.
				stop(result.reason);

				return { _tag: "Interrupted" as const, reason: result.reason, settled };
			});

		const runOccurrence = (occurrence: Occurrence) =>
			Effect.gen(function* () {
				if (halt.reason !== undefined) return;

				const handler = resolved.get(occurrence.id);
				if (handler === undefined) return;

				if (handler.precondition !== undefined) {
					const checked = yield* runPhase(handler.precondition);
					if (checked._tag === "Interrupted") {
						outcomes.set(occurrence.id, {
							_tag: "Interrupted",
							phase: "precondition",
							reason: checked.reason,
							settled: checked.settled,
						});

						return;
					}
					if (Exit.isFailure(checked.exit)) {
						stop("failure");
						outcomes.set(occurrence.id, {
							_tag: "Failed",
							phase: "precondition",
							...failureOf(checked.exit.cause),
						});

						return;
					}
					if (!checked.exit.value) {
						outcomes.set(occurrence.id, {
							_tag: "Skipped",
							reason: handler.skipReason,
						});

						return;
					}
				}

				bodiesStarted = true;
				const ran = yield* runPhase(handler.body);
				if (ran._tag === "Interrupted") {
					outcomes.set(occurrence.id, {
						_tag: "Interrupted",
						phase: "body",
						reason: ran.reason,
						settled: ran.settled,
					});

					return;
				}
				if (Exit.isFailure(ran.exit)) {
					stop("failure");
					outcomes.set(occurrence.id, {
						_tag: "Failed",
						phase: "body",
						...failureOf(ran.exit.cause),
					});

					return;
				}
				outcomes.set(occurrence.id, { _tag: "Completed" });
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
		signal?.removeEventListener("abort", onAbort);

		if (halt.reason === undefined)
			return report(plan, "execute", "completed", outcomes, bodiesStarted);
		if (halt.reason === "failure") {
			const result = report(plan, "execute", "failed", outcomes, bodiesStarted);

			return yield* new ExecutionFailed({
				failures: result.occurrences.filter((entry) => entry.outcome._tag === "Failed"),
				report: result,
			});
		}

		return yield* new ExecutionInterrupted({
			reason: halt.reason,
			report: report(plan, "execute", "interrupted", outcomes, bodiesStarted),
		});
	});

const dryRun = (plan: Plan, resolved: Resolved): Effect.Effect<Report, never, any> =>
	Effect.gen(function* () {
		const outcomes = new Map<string, Outcome>();
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
				if (handler === undefined) return dirty;
				if (failedAt !== undefined) {
					outcomes.set(node.id, {
						_tag: "Undetermined",
						reason: `Execution would stop at the failed precondition of "${failedAt}".`,
					});

					return true;
				}
				if (handler.precondition === undefined) {
					outcomes.set(node.id, { _tag: "WouldExecute", evaluated: false });

					return true;
				}
				if (dirty) {
					outcomes.set(node.id, {
						_tag: "Undetermined",
						reason: "The precondition depends on earlier actions that a dry run does not apply.",
					});

					return true;
				}

				const exit = yield* Effect.exit(handler.precondition);
				if (Exit.isFailure(exit)) {
					failedAt = node.id;
					outcomes.set(node.id, { _tag: "PreconditionFailed", ...failureOf(exit.cause) });

					return true;
				}
				if (!exit.value) {
					outcomes.set(node.id, { _tag: "WouldSkip", reason: handler.skipReason });

					return false;
				}
				outcomes.set(node.id, { _tag: "WouldExecute", evaluated: true });

				return true;
			});

		// Later migrations conservatively depend on every earlier migration.
		let dirty = false;
		for (const step of plan.steps) dirty = yield* visit(step.node, dirty);

		return report(
			plan,
			"dry-run",
			failedAt === undefined ? "would-complete" : "would-fail",
			outcomes,
			false,
		);
	});

/**
 * Runs a plan as an Effect. Coverage is checked before any precondition or body runs.
 * Steps are sequential barriers; parallel groups run their branches concurrently. On
 * failure, no new action starts, and actions already running settle before the effect
 * fails with the partial report.
 *
 * @since @next
 */
export const effect = <A extends Action.Any, H extends Handler.Any = never>(
	plan: Plan<A>,
	options: Options<H> = {},
): Effect.Effect<Report<A, Errors<A, H>>, ExecutionError<A, Errors<A, H>>, Requirements<A, H>> =>
	// The plan's action union and the handler union determine these types; the
	// implementation works on erased handlers.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	Effect.gen(function* () {
		const context = yield* Effect.context();
		const checked = coverage(plan, options.handlers ?? [], context);
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

		return options.dryRun === true
			? yield* dryRun(plan, checked.resolved)
			: yield* execute(plan, checked.resolved, options);
	}) as Effect.Effect<
		Report<A, Errors<A, H>>,
		ExecutionError<A, Errors<A, H>>,
		Requirements<A, H>
	>;

type ServicesOption<R> = [R] extends [never]
	? {
			/** Optional services, such as `Handler.layer` bindings for run-time coverage plans. */
			readonly services?: Context.Context<any> | Layer.Layer<any, unknown>;
		}
	: {
			/** Supplies the handlers' Effect services and any `Handler.layer` bindings. */
			readonly services: Context.Context<R> | Layer.Layer<R, unknown>;
		};

/**
 * Runs a plan and returns a Promise. It rejects with `HandlerCoverageError`,
 * `ExecutionFailed`, or `ExecutionInterrupted`, each carrying the partial report.
 *
 * @since @next
 */
export const runPromise = <A extends Action.Any, H extends Handler.Any = never>(
	plan: Plan<A>,
	options: Options<H> & ServicesOption<Requirements<A, H>>,
): Promise<Report<A, Errors<A, H>>> => {
	const program = effect(plan, options);
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
		provided as Effect.Effect<Report<A, Errors<A, H>>, unknown>,
	).then((exit) => {
		if (Exit.isSuccess(exit)) return exit.value;

		throw Cause.squash(exit.cause);
	});
};
