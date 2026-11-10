import { Cause } from "effect";

import type { Any as AnyPlan } from "../../foundation/plan.ts";
import type { Outcome, Report } from "../execution/executor.ts";
import type * as Observer from "../execution/observer.ts";
import type { Destination, Issue } from "../planning/history.ts";
import {
	counts,
	error as encodeError,
	occurrencesOf,
	outcomeError,
	statusByTag,
	unsettled,
	type OutcomeStatus,
} from "./encode.ts";
import { failureMark } from "./failure.ts";
import type { Style } from "./output.ts";

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const successMark = (style: Style) => (style.rich ? style.green("✓ ") : "");

export const issues = (
	pkg: string,
	value: ReadonlyArray<Issue>,
	versions: number,
	migrations: number,
	style: Style,
) =>
	value.length === 0
		? [
				`${successMark(style)}The history of ${pkg} is valid (${plural(versions, "version")}, ${plural(migrations, "migration")})`,
			]
		: [
				style.red(
					`${failureMark(style.rich)}The history of ${pkg} has ${plural(value.length, "issue")}`,
				),
				...value.map((entry) => `  ${entry._tag}  ${entry.subject}: ${entry.message}`),
			];

export const plan = (pkg: string, value: AnyPlan, explain: boolean, style: Style) => {
	const lines = [
		style.bold(`${pkg} ${value.from.id} ${style.arrow} ${value.to.id} (${value.direction})`),
		`Route  ${value.route.id}`,
	];
	for (const step of value.steps) {
		const direction = step.direction === "revert" ? " (revert)" : "";
		const header = `${step.from.id} ${style.arrow} ${step.to.id}  ${step.migration.id}${direction}`;
		const occurrences = occurrencesOf(value, step);
		lines.push(
			"",
			step.omitted && occurrences.length === 0 ? style.dim(`${header}  no actions`) : header,
		);
		for (const entry of occurrences) {
			lines.push(`  ${entry.id}`, `    ${entry.action.description}`);
			if (entry.origin._tag === "Replacement") {
				const replaced = entry.origin.replaces
					.map((replacedEntry) => replacedEntry.id)
					.join(", ");
				lines.push(style.dim(`    Rule ${entry.origin.rule.id} replaces ${replaced}`));
			}
		}
	}
	if (explain && value.explanations.length > 0) {
		lines.push("", "Explanations");
		for (const entry of value.explanations) {
			lines.push(
				entry._tag === "Rewrite"
					? `  Rule ${entry.rule.id} replaced ${entry.removed.map((removed) => removed.id).join(", ") || "nothing"} with ${entry.produced.map((produced) => produced.id).join(", ") || "nothing"}`
					: `  ${entry.migration.id}${entry.direction === "revert" ? " (revert)" : ""} is left out of the guide: ${entry.reason === "noop" ? "it declares no work" : "rules removed all of its actions"}`,
			);
		}
	}
	lines.push(
		"",
		value.occurrences.length === 0
			? `No actions in ${plural(value.steps.length, "migration")}.`
			: `${plural(value.occurrences.length, "action")} in ${plural(value.steps.length, "migration")}.`,
	);

	return lines;
};

export const destinations = (
	from: string,
	kind: "upgrade" | "downgrade",
	value: ReadonlyArray<Destination>,
	style: Style,
) => {
	if (value.length === 0) return [`No ${kind}s from ${from}`];
	const width = Math.max(...value.map((entry) => entry.version.id.length));

	return [
		style.bold(`${kind === "upgrade" ? "Upgrades" : "Downgrades"} from ${from}`),
		...value.map((entry) => `  ${entry.version.id.padEnd(width)}  ${entry.routes.join(", ")}`),
	];
};

const statusLabels = {
	completed: "completed",
	skipped: "skipped",
	failed: "failed",
	interrupted: "interrupted",
	unattempted: "not attempted",
	"would-execute": "would run",
	"would-skip": "would skip",
	undetermined: "undetermined",
	"precondition-failed": "precondition failed",
} as const satisfies Record<OutcomeStatus, string>;

const labelWidth = Math.max(...Object.values(statusLabels).map((label) => label.length));

/** Detail shared by report outcomes and observer outcome summaries. */
const commonDetail = (value: Outcome | Observer.OutcomeSummary) => {
	switch (value._tag) {
		case "Skipped":
		case "WouldSkip":
		case "Undetermined":
			return `: ${value.reason}`;
		case "Interrupted":
			return ` (${value.phase}, ${value.reason})${value.settled ? "" : ": may still be running"}`;
		default:
			return "";
	}
};

const actionLine = (tag: Outcome["_tag"], occurrence: string, detail: string, style: Style) => {
	const status = statusByTag[tag];
	const label = statusLabels[status].padEnd(labelWidth);
	const colored =
		status === "completed" || status === "would-execute"
			? style.green(label)
			: status === "failed" || status === "precondition-failed"
				? style.red(label)
				: status === "interrupted" || status === "undetermined"
					? style.yellow(label)
					: label;

	return `  ${colored}  ${occurrence}${detail}`;
};

const reportDetail = (value: Outcome) => {
	if (value._tag === "Failed") return ` (${value.phase}): ${outcomeError(value).message}`;
	if (value._tag === "PreconditionFailed") return `: ${outcomeError(value).message}`;

	return commonDetail(value);
};

const summaryDetail = (value: Observer.OutcomeSummary) => {
	const tag =
		value._tag === "Failed" || value._tag === "PreconditionFailed" ? value.errorTag : undefined;
	if (value._tag === "Failed") return ` (${value.phase})${tag === undefined ? "" : `: ${tag}`}`;
	if (value._tag === "PreconditionFailed") return tag === undefined ? "" : `: ${tag}`;

	return commonDetail(value);
};

/**
 * Progress lines for an execution event: a header when a step starts, a line when an
 * action settles. Other events print nothing; the report follows the run.
 */
export const progress = (event: Observer.Event, style: Style): ReadonlyArray<string> => {
	switch (event._tag) {
		case "StepStarted": {
			const { step } = event;
			if (step.kind !== "execute") return [];

			return [style.bold(`Step ${step.id}  ${step.from} ${style.arrow} ${step.to}`)];
		}
		case "ActionSettled": {
			const { actions } = event.progress;
			const count = style.dim(` [${actions.finished}/${actions.total}]`);

			return [
				actionLine(
					event.outcome._tag,
					event.action.occurrence,
					summaryDetail(event.outcome),
					style,
				) + count,
			];
		}
		default:
			return [];
	}
};

const headline = (value: Report, style: Style) => {
	const route = `from ${value.from} to ${value.to}`;
	switch (value.status) {
		case "completed":
			return `${successMark(style)}Migrated ${route}`;
		case "would-complete":
			return `${successMark(style)}Dry run ${route}: every check passed`;
		case "would-fail":
			return style.red(`${failureMark(style.rich)}Dry run ${route}: a precondition failed`);
		case "failed":
			return style.red(`${failureMark(style.rich)}Migration ${route} failed`);
		case "interrupted":
			return style.yellow(`Migration ${route} was interrupted`);
	}

	return style.red(`${failureMark(style.rich)}Migration ${route} did not start`);
};

/** Human report: headline, one line per occurrence, counts, and what was not undone. */
export const report = (value: Report, style: Style) => {
	const lines = [headline(value, style)];
	for (const entry of value.occurrences) {
		lines.push(
			actionLine(entry.outcome._tag, entry.occurrence.id, reportDetail(entry.outcome), style),
		);
	}
	const summary = [...counts(value.occurrences)]
		.filter(([, count]) => count > 0)
		.map(([status, count]) => `${statusLabels[status]} ${count}`);
	if (summary.length > 0) lines.push("", `${summary.join(", ")}.`);
	const pending = unsettled(value);
	if (pending.length > 0) {
		lines.push(
			style.yellow(
				`${plural(pending.length, "interrupted action")} had not stopped and may still be running.`,
			),
		);
	}
	if (value.mode === "execute" && value.status !== "completed" && value.bodiesStarted) {
		lines.push(
			"Completed actions were not rolled back. Progress is not saved: running again repeats them.",
		);
	}

	return lines;
};

/** Warnings for observers that failed or were abandoned. Outcomes are unaffected. */
export const observation = (value: Report, style: Style) =>
	value.observation.map((entry) =>
		style.yellow(
			`Warning: observer ${entry.observer} ${entry.reason === "failed" ? "failed" : "was abandoned"} on ${entry.event} (event ${entry.seq}): ${encodeError(Cause.squash(entry.cause)).message}`,
		),
	);
