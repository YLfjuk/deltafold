import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Result } from "effect";

import { DependentsPolicy, Release, VersionStrategy, type PlanError } from "@deltafold/release";
import { Change } from "deltafold";
import {
	advance,
	headers,
	packageWith,
	ProjectChange,
	retries,
	timeout,
} from "./__fixtures__/packages.ts";

const widgets = packageWith("@acme/widgets", ["1.5.0", "1.5.2"]);
const react = packageWith("@acme/widgets-react", ["1.4.0"]);
const tools = packageWith("@acme/tools", ["0.3.0"]);

const semver = VersionStrategy.semver({
	bump: (change: Change.Change<{ readonly bump: "major" | "minor" | "patch" }>) =>
		change.metadata.bump,
});

const group = Release.make("widgets", {
	packages: [{ package: widgets }, { package: react }, { package: tools, version: semver }],
	change: ProjectChange,
	version: semver,
});

const success = <A>(result: Result.Result<A, PlanError>): A => {
	if (Result.isFailure(result))
		throw new Error(`${result.failure.reason}: ${result.failure.message}`);

	return result.success;
};

const failure = <A>(result: Result.Result<A, PlanError>): PlanError => {
	if (Result.isSuccess(result)) throw new Error("expected a planning failure");

	return result.failure;
};

const summary = (plan: Release.Plan) =>
	plan.versions.map(
		(planned) => `${planned.package}@${planned.version.id}<${planned.version.previous?.id}`,
	);

const selectBaseline = (
	version: Release.VersionSetting<{
		readonly bump: "major" | "minor" | "patch";
		readonly area: "api" | "docs";
	}>,
) =>
	group.plan({
		version,
		packages: [
			{ package: widgets, previous: "1.5.2", changes: [headers] },
			{ package: react, previous: "1.4.0", changes: [] },
			{ package: tools, previous: "0.3.0", changes: [] },
		],
	});

describe("group planning", () => {
	it("aligns unchanged members to the shared version and keeps each package's own ancestry", () => {
		const plan = success(
			group.plan({
				packages: [
					{ package: widgets, previous: "1.5.2", changes: [retries] },
					{ package: react, previous: "1.4.0", changes: [] },
					{ package: tools, previous: "0.3.0", changes: [] },
				],
			}),
		);

		expect(summary(plan)).toEqual([
			"@acme/widgets@1.6.0<1.5.2",
			"@acme/widgets-react@1.6.0<1.4.0",
		]);
		expect(plan.unchanged).toEqual([
			{ package: "@acme/tools", version: "0.3.0", reason: "no-changes" },
		]);
	});

	it("lets unchanged members drift when the strategy allows it", () => {
		const plan = success(
			group.plan({
				version: VersionStrategy.semver({
					bump: (change) => change.metadata.bump,
					unchanged: "drift",
				}),
				packages: [
					{ package: widgets, previous: "1.5.2", changes: [headers] },
					{ package: react, previous: "1.4.0", changes: [] },
					{ package: tools, previous: "0.3.0", changes: [] },
				],
			}),
		);

		expect(summary(plan)).toEqual(["@acme/widgets@1.5.3<1.5.2"]);
		expect(plan.unchanged.map((entry) => entry.reason)).toEqual(["drift", "no-changes"]);
	});

	it("keeps per-package overrides out of the shared calculation", () => {
		const plan = success(
			group.plan({
				packages: [
					{ package: widgets, previous: "1.5.2", changes: [timeout] },
					{ package: react, previous: "1.4.0", changes: [headers] },
					{ package: tools, previous: "0.3.0", changes: [headers] },
				],
			}),
		);

		expect(summary(plan)).toEqual([
			"@acme/widgets@2.0.0<1.5.2",
			"@acme/widgets-react@2.0.0<1.4.0",
			"@acme/tools@0.3.1<0.3.0",
		]);
		expect(plan.versions.map((planned) => planned.source)).toEqual([
			"shared",
			"shared",
			"override",
		]);
	});

	it("accepts literal targets at the root and per package, replacing configured settings", () => {
		const plan = success(
			group.plan({
				version: "3.0.0",
				packages: [
					{ package: widgets, previous: "1.5.2", changes: [retries] },
					{ package: react, previous: "1.4.0", changes: [] },
					{ package: tools, previous: "0.3.0", changes: [], version: "1.0.0" },
				],
			}),
		);

		expect(summary(plan)).toEqual([
			"@acme/widgets@3.0.0<1.5.2",
			"@acme/widgets-react@3.0.0<1.4.0",
			"@acme/tools@1.0.0<0.3.0",
		]);
	});

	it("applies baseline policies and rejects downgrades", () => {
		expect(
			failure(
				selectBaseline(
					VersionStrategy.semver({
						bump: (change) => change.metadata.bump,
						baseline: "require-matching",
					}),
				),
			).reason,
		).toBe("BaselineMismatch");
		expect(
			summary(
				success(
					selectBaseline(
						VersionStrategy.semver({
							bump: (change) => change.metadata.bump,
							baseline: { version: "1.9.0" },
						}),
					),
				),
			),
		).toEqual(["@acme/widgets@1.9.1<1.5.2", "@acme/widgets-react@1.9.1<1.4.0"]);
		const downgrade = failure(
			selectBaseline(
				VersionStrategy.semver({
					bump: (change) => change.metadata.bump,
					baseline: { version: "1.4.0" },
				}),
			),
		);
		expect(downgrade).toMatchObject({ reason: "Downgrade", subjects: ["@acme/widgets"] });
	});

	it("bounds the group and refuses unknown ancestry", () => {
		const outsider = packageWith("@acme/outsider", ["1.0.0"]);
		const base = [
			{ package: widgets, previous: "1.5.2", changes: [retries] },
			{ package: react, previous: "1.4.0", changes: [] },
			{ package: tools, previous: "0.3.0", changes: [] },
		] as const;

		expect(
			failure(
				group.plan({
					packages: [...base, { package: outsider, previous: "1.0.0", changes: [] }],
				}),
			).reason,
		).toBe("OutsideGroup");
		expect(failure(group.plan({ packages: base.slice(0, 2) })).reason).toBe("MissingMember");
		expect(
			failure(
				group.plan({ packages: [{ ...base[0], previous: "1.5.1" }, base[1], base[2]] }),
			),
		).toMatchObject({ reason: "UnknownPrevious", subjects: ["@acme/widgets", "1.5.1"] });
		expect(() =>
			Release.make(" ", { packages: [], change: ProjectChange, version: semver }),
		).toThrow("stable identifier");
	});

	it("plans once with the same contract", () => {
		const input = {
			packages: [
				{ package: widgets, previous: "1.5.2", changes: [retries] },
				{ package: react, previous: "1.4.0", changes: [] },
				{ package: tools, previous: "0.3.0", changes: [] },
			],
		};

		expect(summary(success(Release.plan("widgets", group.config, input)))).toEqual(
			summary(success(group.plan(input))),
		);
	});

	it("reports no work when no package has changes", () => {
		const plan = success(
			group.plan({
				packages: [
					{ package: widgets, previous: "1.5.2", changes: [] },
					{ package: react, previous: "1.4.0", changes: [] },
					{ package: tools, previous: "0.3.0", changes: [] },
				],
			}),
		);

		expect(plan.versions).toEqual([]);
		expect(plan.unchanged).toHaveLength(3);
	});
});

type Impact = { readonly impact: "breaking" | "feature" | "fix" };
const TeamChange = Change.define<Impact>();
const breaking = TeamChange.make("drop-node-18", { impact: "breaking" })`Drop Node.js 18.`;
const app = packageWith("@acme/app", ["4.1.0"]);
const calendar: VersionStrategy.Strategy<Impact> = ({ participants }) => ({
	version: `2026.${participants.length}.0`,
});
// @ts-expect-error strategies are synchronous.
const asynchronous: VersionStrategy.Strategy<Impact> = async () => ({ version: "5.0.0" });

describe("custom factories and strategies", () => {
	it("passes the factory's metadata type to strategies", () => {
		const custom = Release.make("app", {
			packages: [{ package: app }],
			change: TeamChange,
			version: VersionStrategy.semver({
				bump: (change) => {
					expectTypeOf(change.metadata).toEqualTypeOf<Impact>();

					return change.metadata.impact === "breaking"
						? "major"
						: change.metadata.impact === "feature"
							? "minor"
							: "patch";
				},
			}),
		});

		expect(
			summary(
				success(
					custom.plan({
						packages: [{ package: app, previous: "4.1.0", changes: [breaking] }],
					}),
				),
			),
		).toEqual(["@acme/app@5.0.0<4.1.0"]);
		// @ts-expect-error changes from another factory have a different metadata type.
		custom.plan({ packages: [{ package: app, previous: "4.1.0", changes: [retries] }] });
	});

	it("accepts any synchronous strategy and rejects asynchronous results", () => {
		const custom = Release.make("app", {
			packages: [{ package: app }],
			change: TeamChange,
			version: calendar,
		});
		expect(
			summary(
				success(
					custom.plan({
						packages: [{ package: app, previous: "4.1.0", changes: [breaking] }],
					}),
				),
			),
		).toEqual(["@acme/app@2026.1.0<4.1.0"]);

		const rejected = Release.make("app", {
			packages: [{ package: app }],
			change: TeamChange,
			version: asynchronous,
		});
		expect(
			failure(
				rejected.plan({
					packages: [{ package: app, previous: "4.1.0", changes: [breaking] }],
				}),
			).reason,
		).toBe("InvalidStrategyResult");
	});

	it("does not accept a prerelease choice on the group", () => {
		expect(() =>
			Release.make("app", {
				packages: [{ package: app }],
				change: TeamChange,
				version: "5.0.0",
				// @ts-expect-error pre is a per-plan choice.
				pre: { tag: "beta", continue: false },
			}),
		).toThrow("per-plan");
	});
});

describe("prerelease lines", () => {
	const strategy = VersionStrategy.semver({
		bump: (change: Change.Change<{ readonly bump: "major" | "minor" | "patch" }>) =>
			change.metadata.bump,
	});
	const lineGroup = (pkg: ReturnType<typeof packageWith>) =>
		Release.make("solo", {
			packages: [{ package: pkg }],
			change: ProjectChange,
			version: strategy,
		});

	it("starts, continues, elevates, and changes tags", () => {
		let pkg = packageWith("@acme/solo", ["1.5.2"]);
		let previous = "1.5.2";
		let line: VersionStrategy.Line | undefined;
		const step = (
			changes: ReadonlyArray<
				Change.Change<{
					readonly bump: "major" | "minor" | "patch";
					readonly area: "api" | "docs";
				}>
			>,
			pre: VersionStrategy.Pre,
		) => {
			const plan = success(
				lineGroup(pkg).plan({
					packages: [{ package: pkg, previous, changes, ...(line ? { line } : {}) }],
					pre,
				}),
			);
			const [planned] = plan.versions;
			if (planned === undefined) throw new Error("expected a version");
			pkg = advance(pkg, planned);
			previous = planned.version.id;
			line = planned.line;

			return previous;
		};

		expect(step([headers], { tag: "beta", continue: false })).toBe("1.5.3-beta.0");
		expect(step([headers], { tag: "beta", continue: true })).toBe("1.5.3-beta.1");
		expect(step([timeout], { tag: "beta", continue: true })).toBe("2.0.0-beta.0");
		expect(step([headers], { tag: "beta", continue: true })).toBe("2.0.0-beta.1");
		expect(line).toEqual({
			baseline: "1.5.2",
			bump: "major",
			target: "2.0.0",
			tag: "beta",
			counter: 1,
		});
		expect(step([headers], { tag: "rc", continue: true })).toBe("2.0.0-rc.0");
		expect(
			pkg.history.versions.map((version) => `${version.id}<${version.previous?.id}`),
		).toEqual([
			"1.5.2<undefined",
			"1.5.3-beta.0<1.5.2",
			"1.5.3-beta.1<1.5.3-beta.0",
			"2.0.0-beta.0<1.5.3-beta.1",
			"2.0.0-beta.1<2.0.0-beta.0",
			"2.0.0-rc.0<2.0.0-beta.1",
		]);
		expect(() => step([headers], { tag: "alpha", continue: true })).toThrow("downgrade");
	});

	it("refuses continuation without a recorded line, and stable promotion", () => {
		const stable = packageWith("@acme/solo", ["1.5.2"]);
		expect(
			failure(
				lineGroup(stable).plan({
					packages: [{ package: stable, previous: "1.5.2", changes: [headers] }],
					pre: { tag: "beta", continue: true },
				}),
			).reason,
		).toBe("PrereleaseContext");

		const pre = packageWith("@acme/solo", ["1.5.2", "1.5.3-beta.0"]);
		const line = {
			baseline: "1.5.2",
			bump: "patch",
			target: "1.5.3",
			tag: "beta",
			counter: 0,
		} as const;
		expect(
			failure(
				lineGroup(pre).plan({
					packages: [
						{ package: pre, previous: "1.5.3-beta.0", changes: [headers], line },
					],
				}),
			).reason,
		).toBe("StablePromotionUnsupported");
		expect(
			failure(
				Release.make("solo", {
					packages: [{ package: pre }],
					change: ProjectChange,
					version: "1.5.3",
				}).plan({
					packages: [
						{ package: pre, previous: "1.5.3-beta.0", changes: [headers], line },
					],
					pre: { tag: "beta", continue: true },
				}),
			).reason,
		).toBe("ExplicitTargetWithPre");
	});

	it("requires the full pre object", () => {
		const stable = packageWith("@acme/solo", ["1.5.2"]);
		const missingContinue = lineGroup(stable).plan({
			packages: [{ package: stable, previous: "1.5.2", changes: [headers] }],
			// @ts-expect-error continue is required.
			pre: { tag: "beta" },
		});
		const shortcut = lineGroup(stable).plan({
			packages: [{ package: stable, previous: "1.5.2", changes: [headers] }],
			// @ts-expect-error there is no boolean shortcut.
			pre: true,
		});

		expect(failure(missingContinue).reason).toBe("InvalidPre");
		expect(failure(shortcut).reason).toBe("InvalidPre");
	});
});

describe("dependents", () => {
	it("proposes bounded work and reports dependents outside the group", () => {
		const plan = success(
			group.plan({
				dependents: DependentsPolicy.propose(),
				version: VersionStrategy.semver({
					bump: (change) => change.metadata.bump,
					unchanged: "drift",
				}),
				requirements: [
					{
						dependency: "@acme/widgets",
						dependent: "@acme/widgets-react",
						field: "peerDependencies",
						range: "^1.5.0",
						private: false,
					},
					{
						dependency: "@acme/widgets",
						dependent: "@acme/docs-site",
						field: "dependencies",
						range: "^1.5.0",
						private: true,
					},
				],
				packages: [
					{ package: widgets, previous: "1.5.2", changes: [retries] },
					{ package: react, previous: "1.4.0", changes: [] },
					{ package: tools, previous: "0.3.0", changes: [] },
				],
			}),
		);

		expect(
			plan.dependents.map((proposal) => `${proposal.dependent}:${proposal.action}`),
		).toEqual([
			"@acme/widgets-react:edit",
			"@acme/widgets-react:release",
			"@acme/docs-site:cross-group",
		]);
		expect(summary(plan)).toEqual(["@acme/widgets@1.6.0<1.5.2"]);
	});
});
