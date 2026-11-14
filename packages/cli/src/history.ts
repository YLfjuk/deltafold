import { History, Package, Version } from "deltafold";

/**
 * deltafold's own version history. Releases that change the public API add their versions
 * and the migrations between them here, so that `deltafold migrate` can move a project
 * from one deltafold version to another.
 */
export const deltafold = Package.make("deltafold", {
	history: History.make({
		versions: [Version.make("0.0.0", { changes: [] })],
		migrations: [],
	}),
});
