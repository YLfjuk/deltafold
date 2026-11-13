import { Cause } from "effect";

import type { Change } from "../../foundation/change.ts";
import type { Any as AnyPlan, Explanation, Occurrence, Step } from "../../foundation/plan.ts";
import type { OccurrenceReport, Outcome, Report } from "../execution/executor.ts";
import type { Destination, Issue } from "../planning/history.ts";

// JSON projections for `schemaVersion` 1. Absent values are `null`, never omitted. Action
// payloads are not included: they are package-defined values without a runtime schema.

export const issue = (value: Issue) => ({
	tag: value._tag,
	subject: value.subject,
	message: value.message,
});

const change = (value: Change) => ({
	id: value.id,
	kind: value.kind,
	breaking: value.breaking,
	description: value.description,
});

export const occurrence = (value: Occurrence, step: string | null) => ({
	id: value.id,
	step,
	action: value.action.id,
	kind: value.action.kind,
	description: value.action.description,
	migration: value.migration.id,
	direction: value.direction,
	origin:
		value.origin._tag === "Declared"
			? { type: "declared" as const }
			: {
					type: "replacement" as const,
					rule: value.origin.rule.id,
					replaces: value.origin.replaces.map((replaced) => replaced.id),
				},
});

/** The occurrences that belong to a step, in plan order. */
export const occurrencesOf = (plan: AnyPlan, step: Step) =>
	plan.occurrences.filter(
		(entry) => entry.migration.id === step.migration.id && entry.direction === step.direction,
	);

/** The step identifier of each occurrence. */
const stepIds = (plan: AnyPlan) =>
	new Map(
		plan.steps.flatMap((step) =>
			occurrencesOf(plan, step).map((entry): [string, string] => [entry.id, step.id]),
		),
	);

const explanation = (value: Explanation) =>
	value._tag === "Rewrite"
		? {
				type: "rewrite" as const,
				rule: value.rule.id,
				removed: value.removed.map((entry) => entry.id),
				produced: value.produced.map((entry) => entry.id),
			}
		: {
				type: "omitted-step" as const,
				migration: value.migration.id,
				direction: value.direction,
				reason: value.reason,
			};

export const plan = (value: AnyPlan) => {
	const steps = stepIds(value);

	return {
		from: value.from.id,
		to: value.to.id,
		direction: value.direction,
		route: value.route.id,
		steps: value.steps.map((step) => ({
			id: step.id,
			migration: step.migration.id,
			direction: step.direction,
			from: step.from.id,
			to: step.to.id,
			omitted: step.omitted,
			occurrences: occurrencesOf(value, step).map((entry) => entry.id),
		})),
		occurrences: value.occurrences.map((entry) =>
			occurrence(entry, steps.get(entry.id) ?? null),
		),
		changes: value.changes.map(change),
		explanations: value.explanations.map(explanation),
	};
};

export const destination = (value: Destination) => ({
	version: value.version.id,
	routes: value.routes,
});

/** Runs a projection that may throw on hostile values, such as getters or proxies. */
const attempt = <A>(project: () => A, fallback: A): A => {
	try {
		return project();
	} catch {
		return fallback;
	}
};

const stringField = (value: unknown, key: string) =>
	attempt(() => {
		if (typeof value !== "object" || value === null || !(key in value)) return undefined;
		const field: unknown = Reflect.get(value, key);

		return typeof field === "string" ? field : undefined;
	}, undefined);

export type EncodedError = {
	readonly tag: string;
	readonly message: string;
	readonly code: string | null;
	readonly cause?: EncodedError;
};

/** Errors that wrap an unrecognized rejection, which is kept one level deep. */
const wrappers = new Set(["UnexpectedHandlerError", "UnexpectedInteractionError"]);

/**
 * Reduces a failure to its tag, message, and Node.js-style `code`, without stacks or other
 * fields. A wrapper of an unrecognized rejection keeps one reduced level of its cause.
 * Never throws: a value that cannot be read or converted is reported as unprintable.
 */
export const error = (value: unknown): EncodedError => {
	const tag =
		stringField(value, "_tag") ??
		stringField(value, "name") ??
		(value === null ? "null" : typeof value);
	const message =
		stringField(value, "message") ?? attempt(() => String(value), "Unprintable value");
	const base = { tag, message, code: stringField(value, "code") ?? null };
	if (!wrappers.has(tag) || typeof value !== "object" || value === null) return base;
	const cause: unknown = attempt(() => Reflect.get(value, "cause"), undefined);

	return cause === undefined ? base : { ...base, cause: error(cause) };
};

/** The failure of an outcome: its typed error, or the squashed cause for defects. */
export const outcomeError = (value: {
	readonly error: unknown;
	readonly cause: Cause.Cause<unknown>;
}) => error(value.error ?? Cause.squash(value.cause));

export const outcome = (value: Outcome) => {
	switch (value._tag) {
		case "Completed":
			return value.performer === "manual"
				? {
						status: "completed" as const,
						performer: value.performer,
						confirmation: value.confirmation,
					}
				: { status: "completed" as const, performer: value.performer };
		case "Declined":
			return { status: "declined" as const };
		case "Skipped":
			return { status: "skipped" as const, reason: value.reason };
		case "Failed":
			return { status: "failed" as const, phase: value.phase, error: outcomeError(value) };
		case "Interrupted":
			return {
				status: "interrupted" as const,
				phase: value.phase,
				reason: value.reason,
				settled: value.settled,
			};
		case "Unattempted":
			return { status: "unattempted" as const };
		case "WouldExecute":
			return {
				status: "would-execute" as const,
				evaluated: value.evaluated,
				performer: value.performer,
			};
		case "WouldSkip":
			return { status: "would-skip" as const, reason: value.reason };
		case "Undetermined":
			return {
				status: "undetermined" as const,
				reason: value.reason,
				performer: value.performer,
			};
	}

	return { status: "precondition-failed" as const, error: outcomeError(value) };
};

export type OutcomeStatus = ReturnType<typeof outcome>["status"];

export const statusByTag = {
	Completed: "completed",
	Declined: "declined",
	Skipped: "skipped",
	Failed: "failed",
	Interrupted: "interrupted",
	Unattempted: "unattempted",
	WouldExecute: "would-execute",
	WouldSkip: "would-skip",
	Undetermined: "undetermined",
	PreconditionFailed: "precondition-failed",
} as const satisfies Record<Outcome["_tag"], OutcomeStatus>;

const statuses: ReadonlyArray<OutcomeStatus> = [
	"completed",
	"declined",
	"skipped",
	"failed",
	"interrupted",
	"unattempted",
	"would-execute",
	"would-skip",
	"undetermined",
	"precondition-failed",
];

/** Counts of each outcome status, including zeros, in a stable order. */
export const counts = (entries: ReadonlyArray<OccurrenceReport>) => {
	const result = new Map<OutcomeStatus, number>(statuses.map((status) => [status, 0]));
	for (const entry of entries) {
		const status = outcome(entry.outcome).status;
		result.set(status, (result.get(status) ?? 0) + 1);
	}

	return result;
};

/** Interrupted occurrences that may still be changing external state. */
export const unsettled = (value: Report) =>
	value.occurrences.flatMap((entry) =>
		entry.outcome._tag === "Interrupted" && !entry.outcome.settled ? entry.occurrence.id : [],
	);

/** The report, with observer failures reduced to plain fields. */
export const report = (value: Report, resolved: AnyPlan) => {
	const steps = stepIds(resolved);

	return {
		mode: value.mode,
		status: value.status,
		from: value.from,
		to: value.to,
		route: value.route,
		bodiesStarted: value.bodiesStarted,
		persistence: value.persistence,
		summary: Object.fromEntries(counts(value.occurrences)),
		unsettled: unsettled(value),
		observation: value.observation.map((entry) => ({
			observer: entry.observer,
			event: entry.event,
			seq: entry.seq,
			reason: entry.reason,
			error: error(Cause.squash(entry.cause)),
		})),
		occurrences: value.occurrences.map((entry) => ({
			...occurrence(entry.occurrence, steps.get(entry.occurrence.id) ?? null),
			outcome: outcome(entry.outcome),
		})),
	};
};
