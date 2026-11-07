import { Action, Change } from "deltafold";

export type RenamePayload = { readonly target: string; readonly from: string; readonly to: string };

export const RenameKey = Action.define<RenamePayload>("config.rename", {
	describe: ({ target, from, to }) => `In ${target}, rename "${from}" to "${to}"`,
});

export const AddKey = Action.define<{ readonly target: string; readonly key: string }>(
	"config.add",
	{ describe: ({ target, key }) => `In ${target}, add "${key}"` },
);

export const timeoutRenamed = Change.make("2026-11-06.rename-timeout", {
	kind: "changed",
	breaking: true,
})`
	Rename the timeout configuration option to requestTimeout.
`;

export const timeoutRestored = Change.make("2027-02-12.restore-timeout", {
	kind: "changed",
	breaking: true,
	reverts: [timeoutRenamed],
})`Restore the timeout configuration option.`;

export const retriesAdded = Change.make("2026-11-20.add-retries", { kind: "added" })`
	Add a retry limit option.
`;

export const securityFixed = Change.make("2026-12-01.fix-header-injection", { kind: "fixed" })`
	Escape header values.
`;

export const renameTimeout = RenameKey.make("rename-timeout", {
	target: "config",
	from: "timeout",
	to: "requestTimeout",
});

export const restoreTimeout = RenameKey.make("restore-timeout", {
	target: "config",
	from: "requestTimeout",
	to: "timeout",
});

export const addRetryLimit = AddKey.make("add-retry-limit", { target: "config", key: "retries" });
