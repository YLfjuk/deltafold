import { Data, Effect, Runtime } from "effect";

import type { ResolveError, RouteSummary } from "../planning/resolve-error.ts";
import type { RoutePolicy } from "../planning/resolve.ts";
import { Output, stringify } from "./output.ts";

/**
 * Stable machine-readable failure reasons. New reasons may be added; existing ones keep
 * their meaning and exit code.
 */
export type Reason =
	| "invalid_arguments"
	| "unknown_command"
	| "unknown_option"
	| "missing_option"
	| "invalid_value"
	| "unknown_version"
	| "unknown_route"
	| "ambiguous_route"
	| "unsupported_route"
	| "too_many_routes"
	| "rewrite_cycle"
	| "conflicting_rewrites"
	| "rewrite_limit_exceeded"
	| "invalid_history"
	| "invalid_release_metadata"
	| "handlers_load_failed"
	| "handler_coverage"
	| "interaction_required"
	| "manual_work_declined"
	| "execution_failed"
	| "would_fail"
	| "timeout"
	| "write_failed"
	| "internal_error";

/** The version of the JSON documents the CLI prints. */
export const schemaVersion = 1;

/** The route policies `History.resolve` accepts, in documentation order. */
export const policies: ReadonlyArray<RoutePolicy> = [
	"fewest-actions",
	"fewest-migrations",
	"lowest-cost",
	"prefer-shortcuts",
];

/**
 * A failure the CLI has already reported on stderr or in a result document. It carries the
 * process exit code for the runtime and is not logged again.
 */
export class CliFailure extends Data.TaggedError("CliFailure")<{
	readonly reason: Reason;
	readonly message: string;
	readonly exitCode: 1 | 2;
}> {
	override get [Runtime.errorExitCode]() {
		return this.exitCode;
	}

	// `false` tells the main runner that the failure was already shown, so it is not logged.
	override get [Runtime.errorReported]() {
		return false;
	}
}

/** A follow-up command. `args` excludes the migrator's command name. */
export type Next = {
	readonly purpose: string;
	readonly label: string;
	readonly args: ReadonlyArray<string>;
	/** Leaves out `--json`, for commands such as help that only print text. */
	readonly text?: boolean;
};

/** A failure to report: human headline and detail lines, and structured data for JSON. */
export type Problem = {
	readonly reason: Reason;
	readonly message: string;
	readonly status: "error" | "action_required";
	readonly exitCode: 1 | 2;
	readonly details?: ReadonlyArray<string>;
	readonly data?: Readonly<Record<string, unknown>>;
	readonly next?: ReadonlyArray<Next>;
};

const safe = /^[\w.,:@%+=/-]+$/;

/**
 * Quotes an argument for display. Double quotes work in POSIX shells, PowerShell, and cmd
 * for values without `"`, `$`, backticks, backslashes, or `!`; other values use POSIX
 * single quotes. The JSON `argv` field is the exact form.
 */
export const quote = (arg: string) => {
	if (safe.test(arg)) return arg;
	if (!/["$`\\!]/.test(arg)) return `"${arg}"`;

	return `'${arg.replaceAll("'", `'\\''`)}'`;
};

/** The command line for a follow-up command, as an argument vector and display string. */
export const invocation = (program: string, json: boolean, args: ReadonlyArray<string>) => {
	const argv = [program, ...args, ...(json ? ["--json"] : [])];

	return { argv, command: argv.map(quote).join(" ") };
};

/** Shows at most five items, then how many more there are. */
export const capped = (items: ReadonlyArray<string>, limit = 5) =>
	items.length <= limit ? items : [...items.slice(0, limit), `and ${items.length - limit} more`];

/** The headline marker for a failure: a glyph on a terminal, a word otherwise. */
export const failureMark = (rich: boolean) => (rich ? "✗ " : "Error: ");

/**
 * Reports a problem on stderr, as human text or one JSON document, then fails with a
 * `CliFailure` that carries the exit code.
 */
export const fail = (program: string, problem: Problem) =>
	Effect.gen(function* () {
		const output = yield* Output;
		const next = (problem.next ?? []).map((entry) => ({
			purpose: entry.purpose,
			label: entry.label,
			...invocation(program, output.json && entry.text !== true, entry.args),
		}));
		if (output.json) {
			yield* output.failure(
				stringify({
					schemaVersion,
					status: problem.status,
					reason: problem.reason,
					message: problem.message,
					data: problem.data ?? {},
					next: next.map(({ purpose, argv, command }) => ({ purpose, argv, command })),
				}),
			);
		} else {
			const { err } = output;
			const lines = [
				err.red(`${failureMark(err.rich)}${problem.message}`),
				...(problem.details ?? []).map((line) => `  ${line}`),
			];
			for (const entry of next)
				lines.push("", `${entry.label}:`, `    ${err.bold(entry.command)}`);
			yield* output.failure(lines);
		}

		return yield* new CliFailure({
			reason: problem.reason,
			message: problem.message,
			exitCode: problem.exitCode,
		});
	});

const summary = (candidate: RouteSummary) => ({
	id: candidate.id,
	migrations: candidate.migrations,
	shortcuts: candidate.shortcuts,
	actions: candidate.actions ?? null,
	cost: candidate.cost,
	failure: candidate.failure ?? null,
});

const candidateLines = (candidates: ReadonlyArray<RouteSummary>) =>
	capped(
		candidates.map((candidate) => {
			const actions =
				candidate.actions === undefined
					? "cannot be planned"
					: `${candidate.actions} actions`;
			const hops =
				candidate.shortcuts.length === 0
					? `${candidate.migrations.length} migrations`
					: `shortcuts ${candidate.shortcuts.join(", ")}`;

			return `${candidate.id}  (${hops}, ${actions}, cost ${candidate.cost})`;
		}),
	);

const routeChoices = (
	candidates: ReadonlyArray<RouteSummary>,
	replay: (extra: ReadonlyArray<string>) => ReadonlyArray<string>,
): ReadonlyArray<Next> =>
	candidates
		.filter((candidate) => candidate.failure === undefined)
		.slice(0, 2)
		.map((candidate, index) => ({
			purpose: "choose-route",
			label: index === 0 ? "Choose a route" : "Or",
			args: replay(["--route", candidate.id]),
		}));

/**
 * Describes a resolution failure. `replay` rebuilds the failed command with extra
 * arguments, so suggestions keep the user's other options.
 */
export const resolveProblem = (
	error: ResolveError,
	replay: (extra: ReadonlyArray<string>) => ReadonlyArray<string>,
): Problem => {
	switch (error._tag) {
		case "InvalidHistory":
			return {
				reason: "invalid_history",
				message: error.message.split(":")[0] ?? error.message,
				status: "error",
				exitCode: 1,
				details: capped(
					error.issues.map((issue) => `${issue._tag} ${issue.subject}: ${issue.message}`),
				),
				data: {
					issues: error.issues.map((issue) => ({
						tag: issue._tag,
						subject: issue.subject,
						message: issue.message,
					})),
				},
				next: [{ purpose: "validate", label: "List every issue", args: ["validate"] }],
			};
		case "UnknownVersion":
			return {
				reason: "unknown_version",
				message: error.message,
				status: "error",
				exitCode: 2,
				details:
					error.known.length === 0
						? ["The history registers no versions."]
						: [`Known versions: ${capped(error.known, 10).join(", ")}`],
				data: { version: error.version, known: error.known },
			};
		case "UnknownRoute":
			return {
				reason: "unknown_route",
				message: error.message.split(" Candidates:")[0] ?? error.message,
				status: "error",
				exitCode: 2,
				details: [
					"Candidate routes:",
					...candidateLines(error.candidates).map((line) => `  ${line}`),
				],
				data: { route: error.route, candidates: error.candidates.map(summary) },
				next: routeChoices(error.candidates, replay),
			};
		case "AmbiguousRoute":
			return {
				reason: "ambiguous_route",
				message: `${error.candidates.length} routes connect ${error.from} and ${error.to}${
					error.policy === undefined ? "" : ` after the ${error.policy} policy`
				}`,
				status: "action_required",
				exitCode: 2,
				details: [...candidateLines(error.candidates), `Policies: ${policies.join(", ")}`],
				data: {
					from: error.from,
					to: error.to,
					policy: error.policy ?? null,
					candidates: error.candidates.map(summary),
					policies,
				},
				next: routeChoices(error.candidates, replay),
			};
		case "UnsupportedRoute":
			return {
				reason: "unsupported_route",
				message: `No declared ${error.direction} route from ${error.from} to ${error.to}`,
				status: "error",
				exitCode: 1,
				details: [
					...(error.closest.length === 0
						? []
						: [`Closest reachable: ${error.closest.join(", ")}`]),
					...capped(
						error.blockers.map(
							(blocker) =>
								`Blocked: ${blocker.from} -> ${blocker.to}: ${blocker.reason}`,
						),
					),
				],
				data: {
					from: error.from,
					to: error.to,
					direction: error.direction,
					reachable: error.reachable,
					closest: error.closest,
					blockers: error.blockers,
				},
				next: [
					{
						purpose: "list-destinations",
						label: `See where ${error.from} can go`,
						args: [
							error.direction === "downgrade" ? "downgrades" : "upgrades",
							"--from",
							error.from,
						],
					},
				],
			};
		case "TooManyRoutes":
			return {
				reason: "too_many_routes",
				message: error.message,
				status: "error",
				exitCode: 1,
				data: { from: error.from, to: error.to, limit: error.limit },
			};
		case "RewriteCycle":
			return {
				reason: "rewrite_cycle",
				message: error.message,
				status: "error",
				exitCode: 1,
				data: { route: error.route, rules: error.rules, actions: error.actions },
			};
		case "ConflictingRewrites":
			return {
				reason: "conflicting_rewrites",
				message: error.message,
				status: "error",
				exitCode: 1,
				data: { route: error.route, outcomes: error.outcomes },
			};
	}

	return {
		reason: "rewrite_limit_exceeded",
		message: error.message,
		status: "error",
		exitCode: 1,
		data: { route: error.route, limit: error.limit, value: error.value },
	};
};
