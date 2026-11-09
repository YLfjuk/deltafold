import { Action, Handler, History, Migration, Package, Shortcut, Version } from "deltafold";

const SetKey = Action.define<{ readonly key: string }>("config.set", {
	describe: ({ key }) => `Set "${key}"`,
});

const timeoutAction = SetKey.make("set-timeout", { key: "timeout" });
const retriesAction = SetKey.make("set-retries", { key: "retries" });
const bothAction = SetKey.make("set-both", { key: "timeout and retries" });

const v1 = Version.make("1.0.0", { changes: [] });
const v2 = Version.make("2.0.0", { previous: v1, changes: [] });
const v3 = Version.make("3.0.0", { previous: v2, changes: [] });
const toV2 = Migration.make("1.0.0-to-2.0.0", { from: v1, to: v2 })`${timeoutAction}`;
const toV3 = Migration.make("2.0.0-to-3.0.0", { from: v2, to: v3 })`${retriesAction}`;
const direct = Migration.make("1.0.0-to-3.0.0", { from: v1, to: v3 })`${bothAction}`;

/** Two routes connect 1.0.0 and 3.0.0. */
export const widgets = Package.make("@acme/widgets", {
	history: History.make({
		versions: [v1, v2, v3],
		migrations: [toV2, toV3],
		shortcuts: [
			Shortcut.make("fast-upgrade", {
				from: v1,
				to: v3,
				replaces: [toV2, toV3],
				migrations: [direct],
			}),
		],
	}),
});

// WIDGETS_MODE=slow makes the first action wait for cancellation; WIDGETS_MODE=fail makes
// the second action fail.
const mode = process.env["WIDGETS_MODE"];

export const handlers = [
	Handler.promise(timeoutAction, async (_payload, { signal }) => {
		if (mode !== "slow") return;
		process.stderr.write("started\n");
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
	}),
	Handler.promise(retriesAction, async () => {
		if (mode === "fail") throw new Error("disk full");
	}),
	Handler.promise(bothAction, async () => {}),
];
