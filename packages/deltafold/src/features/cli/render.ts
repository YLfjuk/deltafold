import type { Any as AnyPlan } from "../../foundation/plan.ts";
import type { Report } from "../execution/executor.ts";
import type { Destination, Issue } from "../planning/history.ts";
import { counts, occurrencesOf, outcome, outcomeError, unsettled } from "./encode.ts";
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
} as const;

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
	const labelWidth = Math.max(...Object.values(statusLabels).map((label) => label.length));
	for (const entry of value.occurrences) {
		const encoded = outcome(entry.outcome);
		const label = statusLabels[encoded.status].padEnd(labelWidth);
		const colored =
			encoded.status === "completed" || encoded.status === "would-execute"
				? style.green(label)
				: encoded.status === "failed" || encoded.status === "precondition-failed"
					? style.red(label)
					: encoded.status === "interrupted" || encoded.status === "undetermined"
						? style.yellow(label)
						: label;
		let detail = "";
		const current = entry.outcome;
		if (
			current._tag === "Skipped" ||
			current._tag === "WouldSkip" ||
			current._tag === "Undetermined"
		) {
			detail = `: ${current.reason}`;
		} else if (current._tag === "Failed") {
			detail = ` (${current.phase}): ${outcomeError(current).message}`;
		} else if (current._tag === "PreconditionFailed") {
			detail = `: ${outcomeError(current).message}`;
		} else if (current._tag === "Interrupted") {
			detail = ` (${current.phase}, ${current.reason})${current.settled ? "" : ": may still be running"}`;
		}
		lines.push(`  ${colored}  ${entry.occurrence.id}${detail}`);
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
