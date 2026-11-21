import { describe, expect, it } from "@effect/vitest";

import { ReleaseChangelog } from "@deltafold/release/changelog";
import { History, Package, Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";
import { headers, retries, timeout } from "./__fixtures__/packages.ts";

describe("ReleaseChangelog.dependencies", () => {
	const v140 = Version.make("1.4.0", { changes: [] });
	const v141 = Version.make("1.4.1", { previous: v140, changes: [] });
	const react = Package.make("@acme/widgets-react", {
		history: History.make({ versions: [v140, v141], migrations: [] }),
	});
	const render = (options?: ReleaseChangelog.DependenciesOptions) =>
		Markdown.render(
			Changelog.make<ReleaseChangelog.DependencyMetadata>({
				plugins: [ReleaseChangelog.dependencies(options)],
			}).history(react, {
				releases: [
					Version.withMetadata(v140, {}),
					Version.withMetadata(v141, {
						dependencies: [
							{
								dependency: "@acme/widgets",
								field: "peerDependencies",
								from: "^1.5.0",
								to: "^2.0.0",
								version: "2.0.0",
							},
						],
					}),
				],
			}),
		);

	it("renders recorded dependency updates and nothing for releases without them", () => {
		const markdown = render();

		expect(markdown).toContain("### Updated Dependencies\n\n- `@acme/widgets@2.0.0`\n");
		expect(markdown).not.toContain("peerDependencies");
		expect(markdown.match(/Updated Dependencies/g)).toHaveLength(1);
	});

	it("adds the edited field and range change when verbose", () => {
		expect(render({ verbose: true })).toContain(
			"### Updated Dependencies\n\n- `@acme/widgets@2.0.0` (peerDependencies: ^1.5.0 to ^2.0.0)",
		);
	});
});

describe("ReleaseChangelog.bySignificance", () => {
	it("groups changes by bump, strongest first, before dependency updates", () => {
		const v100 = Version.make("1.0.0", { changes: [] });
		const v200 = Version.make("2.0.0", {
			previous: v100,
			changes: [headers, retries, timeout],
		});
		const widgets = Package.make("@acme/widgets", {
			history: History.make({ versions: [v100, v200], migrations: [] }),
		});
		const changelog = Changelog.make<ReleaseChangelog.DependencyMetadata>({
			sections: ReleaseChangelog.bySignificance,
			plugins: [ReleaseChangelog.dependencies()],
		});
		const markdown = Markdown.render(
			changelog.history(widgets, {
				releases: [
					Version.withMetadata(v100, {}),
					Version.withMetadata(v200, {
						dependencies: [
							{
								dependency: "@acme/core",
								field: "dependencies",
								from: "^1.0.0",
								to: "^1.1.0",
								version: "1.1.0",
							},
						],
					}),
				],
			}),
		);
		const headings = [...markdown.matchAll(/^### (.+)$/gm)].map((match) => match[1]);

		expect(headings).toEqual([
			"Major Changes",
			"Minor Changes",
			"Patch Changes",
			"Updated Dependencies",
		]);
		expect(markdown).toContain("Rename the timeout option to requestTimeout.");
	});
});
