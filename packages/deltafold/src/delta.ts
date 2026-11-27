import * as PackageConfig from "./configs/package.ts";
import * as Package from "./features/package.ts";
import * as History from "./features/planning/history.ts";
import * as Version from "./foundation/version.ts";

// Releases that change the public API add their versions and migrations here.
/** @since @next */
export const deltafold = Package.make(PackageConfig.name, {
	history: History.make({
		versions: [Version.make("0.0.0", { changes: [] })],
		migrations: [],
	}),
});
