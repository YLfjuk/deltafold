import { Data } from "effect";

import type { RequestDirection } from "../../foundation/plan.ts";
import type { Issue } from "./validate.ts";

/**
 * A candidate route, summarized for diagnostics and explicit selection.
 *
 * @since @next
 */
export type RouteSummary = {
	/** Pass this as the `route` option to select the route. */
	readonly id: string;
	readonly migrations: ReadonlyArray<string>;
	readonly shortcuts: ReadonlyArray<string>;
	/** Optimized action count, or `undefined` when the route failed to optimize. */
	readonly actions: number | undefined;
	readonly cost: number;
	/** Why the route cannot be planned, if it cannot. */
	readonly failure: string | undefined;
};

/**
 * An ancestry hop with no declared route in the requested direction.
 *
 * @since @next
 */
export type Blocker = {
	readonly from: string;
	readonly to: string;
	readonly reason: string;
};

/**
 * The history's declarations are invalid. Resolution needs a valid history.
 *
 * @since @next
 */
export class InvalidHistory extends Data.TaggedError("InvalidHistory")<{
	readonly issues: ReadonlyArray<Issue>;
}> {
	override get message() {
		return `The history has ${this.issues.length} declaration issue(s): ${this.issues
			.map((issue) => issue.message)
			.join(" ")}`;
	}
}

/** @since @next */
export class UnknownVersion extends Data.TaggedError("UnknownVersion")<{
	readonly version: string;
	readonly known: ReadonlyArray<string>;
}> {
	override get message() {
		return `Version "${this.version}" is not registered in the history.`;
	}
}

/**
 * No declared route connects the versions. This never means that no work is needed:
 * declare `Migration.noop` for a supported zero-work transition.
 *
 * @since @next
 */
export class UnsupportedRoute extends Data.TaggedError("UnsupportedRoute")<{
	readonly from: string;
	readonly to: string;
	readonly direction: RequestDirection;
	/** Versions that are reachable from `from` in the requested direction. */
	readonly reachable: ReadonlyArray<string>;
	/** Reachable versions closest to `to` along release ancestry. Ties are all listed. */
	readonly closest: ReadonlyArray<string>;
	readonly blockers: ReadonlyArray<Blocker>;
}> {
	override get message() {
		const closest =
			this.closest.length === 0 ? "" : ` Closest reachable: ${this.closest.join(", ")}.`;

		return `No declared ${this.direction} route from "${this.from}" to "${this.to}".${closest}`;
	}
}

/**
 * Several routes connect the versions and no selection or policy chose one.
 *
 * @since @next
 */
export class AmbiguousRoute extends Data.TaggedError("AmbiguousRoute")<{
	readonly from: string;
	readonly to: string;
	readonly candidates: ReadonlyArray<RouteSummary>;
	readonly policy: string | undefined;
}> {
	override get message() {
		const ids = this.candidates.map((candidate) => `"${candidate.id}"`).join(", ");
		const reason =
			this.policy === undefined ? "" : ` after applying the "${this.policy}" policy`;

		return `${this.candidates.length} routes connect "${this.from}" and "${this.to}"${reason}: ${ids}. Select one with the \`route\` option, or choose a route policy.`;
	}
}

/**
 * The `route` option names no candidate route.
 *
 * @since @next
 */
export class UnknownRoute extends Data.TaggedError("UnknownRoute")<{
	readonly route: string;
	readonly candidates: ReadonlyArray<RouteSummary>;
}> {
	override get message() {
		return `No candidate route has the identifier "${this.route}". Candidates: ${this.candidates
			.map((candidate) => `"${candidate.id}"`)
			.join(", ")}.`;
	}
}

/**
 * Rules rewrite a sequence back into itself.
 *
 * @since @next
 */
export class RewriteCycle extends Data.TaggedError("RewriteCycle")<{
	readonly route: string;
	readonly rules: ReadonlyArray<string>;
	readonly actions: string;
}> {
	override get message() {
		return `Rules ${this.rules.map((rule) => `"${rule}"`).join(", ")} rewrite a sequence back into itself on route "${this.route}".`;
	}
}

/**
 * Rules can produce different results depending on which applies first.
 *
 * @since @next
 */
export class ConflictingRewrites extends Data.TaggedError("ConflictingRewrites")<{
	readonly route: string;
	readonly outcomes: ReadonlyArray<{
		readonly actions: string;
		readonly rules: ReadonlyArray<string>;
	}>;
}> {
	override get message() {
		return `Rules produce ${this.outcomes.length} different results on route "${this.route}", depending on the order they apply in.`;
	}
}

/**
 * Optimization explored too many states or chained too many rule applications, for
 * example because a rule keeps growing the sequence.
 *
 * @since @next
 */
export class RewriteLimitExceeded extends Data.TaggedError("RewriteLimitExceeded")<{
	readonly route: string;
	readonly limit: "states" | "depth";
	readonly value: number;
}> {
	override get message() {
		return this.limit === "states"
			? `Optimizing route "${this.route}" explored more than ${this.value} states.`
			: `Optimizing route "${this.route}" chained more than ${this.value} rule applications.`;
	}
}

/**
 * More candidate routes exist than the resolver enumerates.
 *
 * @since @next
 */
export class TooManyRoutes extends Data.TaggedError("TooManyRoutes")<{
	readonly from: string;
	readonly to: string;
	readonly limit: number;
}> {
	override get message() {
		return `More than ${this.limit} routes connect "${this.from}" and "${this.to}".`;
	}
}

/** @since @next */
export type RewriteError = RewriteCycle | ConflictingRewrites | RewriteLimitExceeded;

/** @since @next */
export type ResolveError =
	| InvalidHistory
	| UnknownVersion
	| UnsupportedRoute
	| AmbiguousRoute
	| UnknownRoute
	| TooManyRoutes
	| RewriteError;
