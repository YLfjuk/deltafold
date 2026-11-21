import { DependentsPolicy, Release, ReleaseFiles, SemVerStrategy } from "@deltafold/release";
import { ProjectChange } from "./.deltafold/change.ts";
import { adapter } from "./packages/adapter/.deltafold/package.ts";
import { widgets } from "./packages/widgets/.deltafold/package.ts";

export const release = Release.make("fixture-widgets", {
	packages: [
		{
			package: widgets,
			files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }),
		},
		{
			package: adapter,
			files: ReleaseFiles.at("packages/adapter", { manifest: "package.json" }),
		},
	],
	change: ProjectChange,
	version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
	dependents: DependentsPolicy.propose(),
	replacements: [
		{
			files: ["packages/widgets/src/*.ts", "docs/*.md"],
			match: "@next",
			versionOf: widgets,
		},
	],
});
