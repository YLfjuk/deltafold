import { DependentsPolicy, Release, ReleaseFiles, SemVerStrategy } from "@deltafold/release";
import { History, Package } from "deltafold";
import { ProjectChange } from "./changes.ts";
import { version as adapterVersion } from "./packages/adapter/versions/1.2.0.ts";
import { version as widgetsVersion } from "./packages/widgets/versions/1.2.0.ts";

export const widgets = Package.make("@fixture/widgets", {
	history: History.make({ versions: [widgetsVersion], migrations: [] }),
});
export const adapter = Package.make("@fixture/adapter", {
	history: History.make({ versions: [adapterVersion], migrations: [] }),
});

export const configure = (widgetPackage: typeof widgets, adapterPackage: typeof adapter) =>
	Release.make("fixture-widgets", {
		packages: [
			{
				package: widgetPackage,
				files: ReleaseFiles.at("packages/widgets", {
					manifest: "package.json",
					versions: "versions",
				}),
			},
			{
				package: adapterPackage,
				files: ReleaseFiles.at("packages/adapter", {
					manifest: "package.json",
					versions: "versions",
				}),
			},
		],
		change: ProjectChange,
		version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
		dependents: DependentsPolicy.propose(),
		replacements: [
			{
				files: ["packages/widgets/src/*.ts", "docs/*.md"],
				match: "@next",
				versionOf: widgetPackage,
			},
		],
	});

export const release = configure(widgets, adapter);
