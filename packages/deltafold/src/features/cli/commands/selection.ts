import { Effect, Option, Result } from "effect";

import * as History from "../../planning/history.ts";
import type { RoutePolicy } from "../../planning/resolve.ts";
import { fail, resolveProblem } from "../failure.ts";
import type { Definition } from "./definition.ts";

export type Selection = {
	readonly from: string;
	readonly to: string;
	readonly route: Option.Option<string>;
	readonly policy: Option.Option<RoutePolicy>;
};

/**
 * Resolves the plan for a command, or reports why it cannot. `args` is the command's own
 * argument list, reused in suggested commands.
 */
export const resolve = (
	definition: Definition,
	selection: Selection,
	args: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		if (Option.isSome(selection.route) && Option.isSome(selection.policy)) {
			return yield* fail({
				reason: "invalid_arguments",
				message: "Pass either --route or --policy, not both",
				status: "error",
				exitCode: 2,
			});
		}
		const resolved = History.resolve(definition.package.history, {
			from: selection.from,
			to: selection.to,
			...(Option.isSome(selection.route) ? { route: selection.route.value } : {}),
			...(Option.isSome(selection.policy) ? { policy: selection.policy.value } : {}),
		});
		if (Result.isSuccess(resolved)) return resolved.success;

		return yield* fail(resolveProblem(resolved.failure, (extra) => [...args, ...extra]));
	});

/** The arguments of a selection, without `--route` and `--policy`. */
export const selectionArgs = (command: string, selection: Selection) => [
	command,
	"--from",
	selection.from,
	"--to",
	selection.to,
];
