import { describe, expect, it } from "@effect/vitest";

import { ReleaseChangelog } from "@deltafold/release";
import { History, Package, Version } from "deltafold";
import { Changelog } from "deltafold/changelog";
import * as Markdown from "deltafold/markdown";

describe("ReleaseChangelog.dependencies", () => {
	const v140 = Version.make("1.4.0", { changes: [] });
	const v141 = Version.make("1.4.1", { previous: v140, changes: [] });
	const react = Package.make("@acme/widgets-react", {
		history: History.make({ versions: [v140, v141], migrations: [] }),
	});
	const changelog = Changelog.make<ReleaseChangelog.DependencyMetadata>({
		plugins: [ReleaseChangelog.dependencies],
	});

	it("renders recorded dependency updates and nothing for releases without them", () => {
		const markdown = Markdown.render(
			changelog.history(react, {
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

		expect(markdown).toContain(
			"### Updated Dependencies\n\n- `@acme/widgets@2.0.0` (peerDependencies: ^1.5.0 to ^2.0.0)",
		);
		expect(markdown.match(/Updated Dependencies/g)).toHaveLength(1);
	});
});
