import { ReleaseChange, type Release } from "@deltafold/release";
import { History, Package, Version, type Change } from "deltafold";

export type ProjectMetadata = ReleaseChange.Metadata & { readonly area: "api" | "docs" };

export const ProjectChange: Change.Definition<ProjectMetadata> = ReleaseChange.define<{
	readonly area: "api" | "docs";
}>();

export const packageWith = (name: string, ids: ReadonlyArray<string>): Package.Package => {
	const versions: Array<Version.Version> = [];
	for (const id of ids)
		versions.push(Version.make(id, { previous: versions.at(-1), changes: [] }));

	return Package.make(name, { history: History.make({ versions, migrations: [] }) });
};

/** Returns the package with a planned version appended to its history. */
export const advance = (pkg: Package.Package, planned: Release.PlannedVersion): Package.Package =>
	Package.make(pkg.name, {
		history: History.make({
			versions: [...pkg.history.versions, planned.version],
			migrations: [],
		}),
	});

export const retries: Change.Change<ProjectMetadata> = ProjectChange.make("add-retries", {
	bump: "minor",
	area: "api",
})`
	Add a retry limit option.
`;
export const headers: Change.Change<ProjectMetadata> = ProjectChange.make("fix-headers", {
	bump: "patch",
	area: "api",
})`
	Escape header values.
`;
export const timeout: Change.Change<ProjectMetadata> = ProjectChange.make("rename-timeout", {
	bump: "major",
	area: "api",
})`
	Rename the timeout option to requestTimeout.
`;
