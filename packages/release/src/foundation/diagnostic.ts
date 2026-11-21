import { issue, PlanError } from "./error.ts";

const trusted = new WeakSet<PlanError>();

/**
 * Throws a planning diagnostic from this package's own code, such as the built-in SemVer
 * strategy. The planner reports these as they are; a `PlanError` thrown by a custom
 * strategy is reported as an invalid strategy result instead.
 */
export const diagnose = (...args: Parameters<typeof issue>): never => {
	const error = new PlanError(issue(...args));
	trusted.add(error);
	throw error;
};

export const isDiagnostic = (error: unknown): error is PlanError =>
	error instanceof PlanError && trusted.has(error);
