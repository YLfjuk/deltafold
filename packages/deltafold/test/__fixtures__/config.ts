import { Action, Change } from "deltafold";

export type RenamePayload = { readonly target: string; readonly from: string; readonly to: string };

export const RenameKey = Action.define<RenamePayload>("config.rename", {
	describe: ({ target, from, to }) => `In ${target}, rename "${from}" to "${to}"`,
});

export const AddKey = Action.define<{ readonly target: string; readonly key: string }>(
	"config.add",
	{ describe: ({ target, key }) => `In ${target}, add "${key}"` },
);

/** The metadata this fixture package declares on its changes. */
export type ConfigChangeMetadata = {
	readonly kind: "added" | "changed" | "fixed";
	readonly breaking: boolean;
};

export const ConfigChange = Change.define<ConfigChangeMetadata>();

export const timeoutRenamed = ConfigChange.make("2026-11-06.rename-timeout", {
	kind: "changed",
	breaking: true,
})`
	Rename the timeout configuration option to requestTimeout.
`;

export const timeoutRestored = ConfigChange.make(
	"2027-02-12.restore-timeout",
	{ kind: "changed", breaking: true },
	{ reverts: [timeoutRenamed] },
)`Restore the timeout configuration option.`;

export const retriesAdded = ConfigChange.make("2026-11-20.add-retries", {
	kind: "added",
	breaking: false,
})`
	Add a retry limit option.
`;

export const securityFixed = ConfigChange.make("2026-12-01.fix-header-injection", {
	kind: "fixed",
	breaking: false,
})`
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
