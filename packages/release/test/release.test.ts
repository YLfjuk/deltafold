import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Result, SemVer } from "effect";

import {
	DependentsPolicy,
	Release,
	VersionStrategy,
	type PlanError,
	SemVerStrategy,
} from "@deltafold/release";
import { Change, History, Package, Version } from "deltafold";
import {
	advance,
	headers,
	member,
	packageWith,
	ProjectChange,
	type ProjectMetadata,
	retries,
	timeout,
} from "./__fixtures__/packages.ts";

const widgets = packageWith("@acme/widgets", ["1.5.0", "1.5.2"]);
const react = packageWith("@acme/widgets-react", ["1.4.0"]);
const tools = packageWith("@acme/tools", ["0.3.0"]);

const semver = SemVerStrategy.make({
	bump: (change: Change.Change<{ readonly bump: "major" | "minor" | "patch" }>) =>
		change.metadata.bump,
});

const group = Release.make("widgets", {
	packages: [member(widgets), member(react), { ...member(tools), version: semver }],
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
	version:
		| string
		| VersionStrategy.VersionStrategy<
				ProjectMetadata,
				SemVerStrategy.Version,
				SemVerStrategy.Input | undefined,
				SemVerStrategy.Details
		  >,
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
			{
				package: "@acme/tools",
				version: "0.3.0",
				reason: "no-changes",
				previousFrom: "stated",
			},
		]);
	});

	it("lets unchanged members drift when the strategy allows it", () => {
		const plan = success(
			group.plan({
				version: SemVerStrategy.make({
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
					SemVerStrategy.make({
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
						SemVerStrategy.make({
							bump: (change) => change.metadata.bump,
							baseline: { version: "1.9.0" },
						}),
					),
				),
			),
		).toEqual(["@acme/widgets@1.9.1<1.5.2", "@acme/widgets-react@1.9.1<1.4.0"]);
		const downgrade = failure(
			selectBaseline(
				SemVerStrategy.make({
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
const calendar = VersionStrategy.make<Impact, SemVerStrategy.Version>({
	name: "calendar",
	scheme: SemVerStrategy.scheme,
	calculate: ({ participants }) => ({
		version: SemVer.make({ major: 2026, minor: participants.length, patch: 0 }),
	}),
});
const asynchronous = VersionStrategy.make<Impact, SemVerStrategy.Version>({
	name: "asynchronous",
	scheme: SemVerStrategy.scheme,
	// @ts-expect-error strategies are synchronous.
	calculate: async () => ({ version: SemVer.parseUnsafe("5.0.0") }),
});

const plain = () => ({ version: SemVer.parseUnsafe("5.0.0") });
const strategyThat = (calculate: () => never) =>
	Release.make("app", {
		packages: [member(app)],
		change: TeamChange,
		version: VersionStrategy.make<Impact, SemVerStrategy.Version>({
			name: "picky",
			scheme: SemVerStrategy.scheme,
			calculate,
		}),
	}).plan({ packages: [{ package: app, changes: [breaking] }] });

describe("custom factories and strategies", () => {
	it("passes the factory's metadata type to strategies", () => {
		const custom = Release.make("app", {
			packages: [member(app)],
			change: TeamChange,
			version: SemVerStrategy.make({
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
			packages: [member(app)],
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
			packages: [member(app)],
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

	it.live("handles rejected asynchronous strategies and policies before refusing them", () => {
		const rejecting = VersionStrategy.make<Impact, SemVerStrategy.Version>({
			name: "rejecting",
			scheme: SemVerStrategy.scheme,
			// @ts-expect-error strategies are synchronous.
			calculate: () => Promise.reject(new Error("strategy failed")),
		});
		const byStrategy = Release.make("app", {
			packages: [member(app)],
			change: TeamChange,
			version: rejecting,
		}).plan({ packages: [{ package: app, previous: "4.1.0", changes: [breaking] }] });
		expect(failure(byStrategy).reason).toBe("InvalidStrategyResult");

		const byPolicy = Release.make("app", {
			packages: [member(app)],
			change: TeamChange,
			version: calendar,
			// @ts-expect-error dependents policies are synchronous.
			dependents: () => Promise.reject(new Error("policy failed")),
		}).plan({ packages: [{ package: app, previous: "4.1.0", changes: [breaking] }] });
		expect(failure(byPolicy).reason).toBe("InvalidPolicyResult");

		// An unhandled rejection would surface after the refusal and fail the run.
		return Effect.sleep("10 millis");
	});

	it("refuses plain functions, reports refusals, and wraps foreign throws", () => {
		expect(() =>
			Release.make("app", {
				packages: [member(app)],
				change: TeamChange,
				// @ts-expect-error a plain function is not a strategy.
				version: plain,
			}),
		).toThrow("not a version strategy");

		expect(
			failure(strategyThat(() => VersionStrategy.refuse("not today", ["@acme/app"]))),
		).toMatchObject({
			reason: "StrategyRefused",
			message: "picky: not today",
			subjects: ["picky", "@acme/app"],
		});
		expect(
			failure(
				strategyThat(() => {
					throw new TypeError("boom");
				}),
			),
		).toMatchObject({ reason: "InvalidStrategyResult", subjects: ["picky"] });
	});

	it("does not accept a prerelease choice on the group", () => {
		expect(() =>
			Release.make("app", {
				packages: [member(app)],
				change: TeamChange,
				version: calendar,
				// @ts-expect-error pre is a per-plan choice.
				input: { pre: { tag: "beta", continue: false } },
			}),
		).toThrow("per-plan");
	});

	it("takes literal targets only as plan input", () => {
		expect(() =>
			Release.make("app", {
				packages: [member(app)],
				change: TeamChange,
				// @ts-expect-error a fixed version would apply to every release of the group.
				version: "5.0.0",
			}),
		).toThrow("not a version strategy");
		const custom = Release.make("app", {
			packages: [
				{
					...member(app),
					// @ts-expect-error per-package group settings are strategies too.
					version: "5.0.0",
				},
			],
			change: TeamChange,
			version: calendar,
		});
		expect(
			summary(
				success(
					custom.plan({
						packages: [
							{
								package: app,
								previous: "4.1.0",
								changes: [breaking],
								version: "5.0.0",
							},
						],
					}),
				),
			),
		).toEqual(["@acme/app@5.0.0<4.1.0"]);
	});
});

describe("prerelease lines", () => {
	const strategy = SemVerStrategy.make({
		bump: (change: Change.Change<{ readonly bump: "major" | "minor" | "patch" }>) =>
			change.metadata.bump,
	});
	const lineGroup = (pkg: ReturnType<typeof packageWith>) =>
		Release.make("solo", {
			packages: [member(pkg)],
			change: ProjectChange,
			version: strategy,
		});

	it("starts, continues, elevates, and changes tags", () => {
		let pkg = packageWith("@acme/solo", ["1.5.2"]);
		let previous = "1.5.2";
		let line: SemVerStrategy.Line | undefined;
		const step = (
			changes: ReadonlyArray<
				Change.Change<{
					readonly bump: "major" | "minor" | "patch";
					readonly area: "api" | "docs";
				}>
			>,
			pre: SemVerStrategy.Pre,
		) => {
			const plan = success(
				lineGroup(pkg).plan({
					packages: [{ package: pkg, previous, changes }],
					input: { pre },
				}),
			);
			const [planned] = plan.versions;
			if (planned === undefined) throw new Error("expected a version");
			pkg = advance(pkg, planned);
			previous = planned.version.id;
			line = planned.details?.line;

			return previous;
		};

		expect(step([headers], { tag: "beta", continue: false })).toBe("1.5.3-beta.0");
		expect(step([headers], { tag: "beta", continue: true })).toBe("1.5.3-beta.1");
		expect(step([timeout], { tag: "beta", continue: true })).toBe("2.0.0-beta.0");
		expect(step([headers], { tag: "beta", continue: true })).toBe("2.0.0-beta.1");
		expect(line && SemVerStrategy.encodeLine(line)).toEqual({
			baseline: "1.5.2",
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

	it("refuses continuation from a stable version", () => {
		const stable = packageWith("@acme/solo", ["1.5.2"]);
		expect(
			failure(
				lineGroup(stable).plan({
					packages: [{ package: stable, previous: "1.5.2", changes: [headers] }],
					input: { pre: { tag: "beta", continue: true } },
				}),
			).reason,
		).toBe("PrereleaseContext");
	});

	it("treats a target with pre as the line's stable target", () => {
		let pkg = packageWith("@acme/solo", ["1.5.2"]);
		let previous = "1.5.2";
		let line: SemVerStrategy.Line | undefined;
		const step = (options: {
			readonly input?: SemVerStrategy.Input;
			readonly changes: ReadonlyArray<Change.Change<ProjectMetadata>>;
		}) => {
			const planned = success(
				lineGroup(pkg).plan({
					...(options.input === undefined ? {} : { input: options.input }),
					packages: [{ package: pkg, previous, changes: options.changes }],
				}),
			).versions[0];
			if (planned === undefined) throw new Error("expected a version");
			pkg = advance(pkg, planned);
			previous = planned.version.id;
			line = planned.details?.line;

			return previous;
		};

		expect(
			step({
				input: { pre: { tag: "beta", continue: false }, target: "3.0.0" },
				changes: [retries],
			}),
		).toBe("3.0.0-beta.0");
		expect(line && SemVerStrategy.encodeLine(line)).toEqual({
			baseline: "1.5.2",
			target: "3.0.0",
			tag: "beta",
			counter: 0,
		});
		// The calculated target would be 2.0.0; continuing keeps the line's 3.0.0.
		expect(step({ input: { pre: { tag: "beta", continue: true } }, changes: [headers] })).toBe(
			"3.0.0-beta.1",
		);
		expect(step({ changes: [retries, headers] })).toBe("3.0.0");
	});

	it("refuses prerelease targets with pre and targets below the line", () => {
		const pre = packageWith("@acme/solo", ["1.5.2", "3.0.0-beta.1"]);
		const plan = (target: string) =>
			lineGroup(pre).plan({
				input: { pre: { tag: "beta", continue: true }, target },
				packages: [{ package: pre, previous: "3.0.0-beta.1", changes: [headers] }],
			});

		expect(failure(plan("3.0.0-beta.4")).reason).toBe("PrereleaseTarget");
		expect(failure(plan("2.0.0")).reason).toBe("Downgrade");
	});

	it("requires the full pre object", () => {
		const stable = packageWith("@acme/solo", ["1.5.2"]);
		const missingContinue = lineGroup(stable).plan({
			packages: [{ package: stable, previous: "1.5.2", changes: [headers] }],
			// @ts-expect-error continue is required.
			input: { pre: { tag: "beta" } },
		});
		const shortcut = lineGroup(stable).plan({
			packages: [{ package: stable, previous: "1.5.2", changes: [headers] }],
			// @ts-expect-error there is no boolean shortcut.
			input: { pre: true },
		});

		expect(failure(missingContinue).reason).toBe("InvalidInput");
		expect(failure(shortcut).reason).toBe("InvalidInput");
	});
});

const requirement = (
	dependent: string,
	dependency: string,
	range: string,
	options: { readonly field?: string; readonly private?: boolean } = {},
): DependentsPolicy.Requirement => ({
	dependency,
	dependent,
	field: options.field ?? "peerDependencies",
	range,
	manifest: `packages/${dependent.replace("@acme/", "")}/package.json`,
	private: options.private ?? false,
});

const actions = (plan: Release.Plan) =>
	plan.dependents.map(
		(proposal) => `${proposal.dependent}<${proposal.dependency}:${proposal.action}`,
	);

describe("dependents", () => {
	const drifting = SemVerStrategy.make({
		bump: (change: Change.Change<ProjectMetadata>) => change.metadata.bump,
		unchanged: "drift",
	});
	const planWith = (input: {
		readonly widgetChanges: ReadonlyArray<Change.Change<ProjectMetadata>>;
		readonly requirements: ReadonlyArray<DependentsPolicy.Requirement>;
		readonly dependents: DependentsPolicy.Policy;
		readonly version?:
			| string
			| VersionStrategy.VersionStrategy<
					ProjectMetadata,
					SemVerStrategy.Version,
					SemVerStrategy.Input | undefined,
					SemVerStrategy.Details
			  >;
	}) =>
		group.plan({
			dependents: input.dependents,
			version: input.version ?? drifting,
			requirements: input.requirements,
			packages: [
				{ package: widgets, previous: "1.5.2", changes: input.widgetChanges },
				{ package: react, previous: "1.4.0", changes: [] },
				{ package: tools, previous: "0.3.0", changes: [] },
			],
		});

	it("releases dependents whose ranges break, through every hop, as patch intent", () => {
		const plan = success(
			planWith({
				widgetChanges: [timeout],
				dependents: DependentsPolicy.propose(),
				requirements: [
					requirement("@acme/widgets-react", "@acme/widgets", "^1.5.0"),
					requirement("@acme/tools", "@acme/widgets-react", "1.4.0", {
						field: "dependencies",
					}),
					requirement("@acme/docs-site", "@acme/widgets", "^1.5.0", { private: true }),
				],
			}),
		);

		expect(summary(plan)).toEqual([
			"@acme/widgets@2.0.0<1.5.2",
			"@acme/widgets-react@1.4.1<1.4.0",
			"@acme/tools@0.3.1<0.3.0",
		]);
		expect(plan.versions.map((planned) => planned.reason)).toEqual([
			"changes",
			"dependencies",
			"dependencies",
		]);
		expect(plan.versions[1]?.version.changes).toEqual([]);
		expect(plan.versions[1]?.dependencies).toMatchObject([
			{ dependency: "@acme/widgets", from: "^1.5.0", to: "^2.0.0", version: "2.0.0" },
		]);
		expect(plan.dependencyUpdates.map((update) => `${update.dependent}:${update.to}`)).toEqual([
			"@acme/tools:1.4.1",
			"@acme/widgets-react:^2.0.0",
		]);
		expect(actions(plan)).toEqual([
			"@acme/docs-site<@acme/widgets:cross-group",
			"@acme/tools<@acme/widgets-react:edit",
			"@acme/widgets-react<@acme/widgets:edit",
		]);
	});

	it("aligns a dependency-only release to the shared version", () => {
		const plan = success(
			planWith({
				widgetChanges: [timeout],
				version: semver,
				dependents: DependentsPolicy.propose(),
				requirements: [requirement("@acme/widgets-react", "@acme/widgets", "^1.5.0")],
			}),
		);

		expect(summary(plan)).toEqual([
			"@acme/widgets@2.0.0<1.5.2",
			"@acme/widgets-react@2.0.0<1.4.0",
		]);
		expect(actions(plan)).toEqual(["@acme/widgets-react<@acme/widgets:edit"]);
	});

	it("leaves satisfied ranges alone unless configured to always update them", () => {
		const input = {
			widgetChanges: [retries],
			requirements: [requirement("@acme/widgets-react", "@acme/widgets", "^1.5.0")],
		};
		const preserved = success(planWith({ ...input, dependents: DependentsPolicy.propose() }));
		expect(summary(preserved)).toEqual(["@acme/widgets@1.6.0<1.5.2"]);
		expect(actions(preserved)).toEqual(["@acme/widgets-react<@acme/widgets:satisfied"]);

		const always = success(
			planWith({
				...input,
				dependents: DependentsPolicy.propose({ updateRanges: "always" }),
			}),
		);
		expect(always.dependencyUpdates.map((update) => update.to)).toEqual(["^1.6.0"]);
		expect(summary(always)).toContain("@acme/widgets-react@1.4.1<1.4.0");
	});

	it("reports missing selections, workspace ranges, and refuses unsupported ranges", () => {
		const explicit = success(
			planWith({
				widgetChanges: [timeout],
				dependents: DependentsPolicy.explicit(),
				requirements: [
					requirement("@acme/widgets-react", "@acme/widgets", "^1.5.0"),
					requirement("@acme/tools", "@acme/widgets", "workspace:^"),
				],
			}),
		);
		expect(summary(explicit)).toEqual(["@acme/widgets@2.0.0<1.5.2"]);
		expect(actions(explicit)).toEqual([
			"@acme/tools<@acme/widgets:workspace",
			"@acme/widgets-react<@acme/widgets:edit",
			"@acme/widgets-react<@acme/widgets:missing-selection",
		]);

		expect(
			failure(
				planWith({
					widgetChanges: [timeout],
					dependents: DependentsPolicy.propose(),
					requirements: [requirement("@acme/widgets-react", "@acme/widgets", ">=1 <2")],
				}),
			),
		).toMatchObject({
			reason: "UnsupportedRange",
			subjects: [
				"packages/widgets-react/package.json",
				"@acme/widgets-react",
				"@acme/widgets",
				"peerDependencies",
			],
		});
	});

	it("leaves a satisfied range alone whatever its form, with npm prerelease and build rules", () => {
		const satisfied = success(
			planWith({
				widgetChanges: [timeout],
				dependents: DependentsPolicy.propose(),
				requirements: [requirement("@acme/widgets-react", "@acme/widgets", ">=1 <3")],
			}),
		);
		expect(actions(satisfied)).toEqual(["@acme/widgets-react<@acme/widgets:satisfied"]);
		// Build metadata does not affect range matching.
		const built = success(
			planWith({
				widgetChanges: [retries],
				version: "1.6.0+build.1",
				dependents: DependentsPolicy.propose(),
				requirements: [requirement("@acme/widgets-react", "@acme/widgets", "1.6.0")],
			}),
		);
		expect(actions(built)).toEqual(["@acme/widgets-react<@acme/widgets:satisfied"]);

		const prerelease = packageWith("@acme/pre-dep", ["2.0.0-beta.0"]);
		const dependent = packageWith("@acme/pre-user", ["1.0.0"]);
		const lines = Release.make("pre-dep", {
			packages: [member(prerelease), member(dependent)],
			change: ProjectChange,
			version: SemVerStrategy.make({
				bump: (change) => change.metadata.bump,
				unchanged: "drift",
			}),
			dependents: DependentsPolicy.propose(),
		});
		const continued = (range: string) =>
			success(
				lines.plan({
					input: { pre: { tag: "beta", continue: true } },
					requirements: [requirement("@acme/pre-user", "@acme/pre-dep", range)],
					packages: [{ package: prerelease, changes: [headers] }, dependent],
				}),
			);
		// 2.0.0-beta.1 satisfies ^ and ~ ranges on the same prerelease version.
		expect(actions(continued("^2.0.0-beta.0"))).toEqual([
			"@acme/pre-user<@acme/pre-dep:satisfied",
		]);
		expect(actions(continued("~2.0.0-beta.0"))).toEqual([
			"@acme/pre-user<@acme/pre-dep:satisfied",
		]);
		// A stable range never admits a prerelease. The dependent joins the line with its own
		// counter, and records no changes.
		const joined = continued("^1.0.0");
		expect(actions(joined)).toEqual(["@acme/pre-user<@acme/pre-dep:edit"]);
		expect(summary(joined)).toEqual([
			"@acme/pre-dep@2.0.0-beta.1<2.0.0-beta.0",
			"@acme/pre-user@2.0.0-beta.0<1.0.0",
		]);
		expect(joined.versions[1]?.version.changes).toEqual([]);
	});
});

describe("stable promotion", () => {
	const revertRetries = ProjectChange.make(
		"revert-retries",
		{ bump: "patch", area: "api" },
		{ reverts: [retries] },
	)`Remove the retry limit option again.`;
	const betaCrash = ProjectChange.make("fix-beta-crash", { bump: "patch", area: "api" })`
		Fix a crash introduced in 2.0.0-beta.0.
	`;
	const v152 = Version.make("1.5.2", { changes: [] });
	const beta0 = Version.make("2.0.0-beta.0", { previous: v152, changes: [timeout, retries] });
	const beta1 = Version.make("2.0.0-beta.1", {
		previous: beta0,
		changes: [revertRetries, betaCrash, timeout],
	});
	const solo = Package.make("@acme/solo", {
		history: History.make({ versions: [v152, beta0, beta1], migrations: [] }),
	});
	const promote = (changes: ReadonlyArray<Change.Change<ProjectMetadata>>) =>
		Release.make("solo", {
			packages: [member(solo)],
			change: ProjectChange,
			version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
		}).plan({
			packages: [{ package: solo, previous: "2.0.0-beta.1", changes }],
		});

	it("lists the line's changes since the last stable ancestor without choosing", () => {
		const listed = success(SemVerStrategy.prereleaseChanges(solo, "2.0.0-beta.1"));

		expect(listed.stable).toBe("1.5.2");
		expect(listed.versions).toEqual(["2.0.0-beta.0", "2.0.0-beta.1"]);
		expect(
			listed.changes.map((entry) => ({
				id: entry.change.id,
				versions: entry.versions,
				revertedBy: entry.revertedBy,
				reverts: entry.reverts,
			})),
		).toEqual([
			{
				id: "rename-timeout",
				versions: ["2.0.0-beta.0", "2.0.0-beta.1"],
				revertedBy: [],
				reverts: [],
			},
			{
				id: "add-retries",
				versions: ["2.0.0-beta.0"],
				revertedBy: ["revert-retries"],
				reverts: [],
			},
			{
				id: "revert-retries",
				versions: ["2.0.0-beta.1"],
				revertedBy: [],
				reverts: ["add-retries"],
			},
			{ id: "fix-beta-crash", versions: ["2.0.0-beta.1"], revertedBy: [], reverts: [] },
		]);
		expect(failure(SemVerStrategy.prereleaseChanges(solo, "1.5.2")).reason).toBe(
			"NotPrerelease",
		);
		expect(failure(SemVerStrategy.prereleaseChanges(solo, "9.9.9")).reason).toBe(
			"UnknownPrevious",
		);
	});

	it("records exactly the selected changes at the line's target", () => {
		const plan = success(promote([timeout]));
		const [planned] = plan.versions;

		expect(planned?.version.id).toBe("2.0.0");
		expect(planned?.version.previous?.id).toBe("2.0.0-beta.1");
		expect(planned?.version.changes.map((change) => change.id)).toEqual(["rename-timeout"]);
		expect(planned?.details?.line).toBeUndefined();
	});

	it("raises the target for stronger selected changes and needs a line-shaped prerelease", () => {
		const patchOnly = packageWith("@acme/patch", ["1.5.2", "1.5.3-beta.0"]);
		const raised = Release.make("patch", {
			packages: [member(patchOnly)],
			change: ProjectChange,
			version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
		}).plan({
			packages: [
				{
					package: patchOnly,
					previous: "1.5.3-beta.0",
					changes: [headers, retries],
				},
			],
		});

		expect(success(raised).versions[0]?.version.id).toBe("1.6.0");
		const unshaped = packageWith("@acme/unshaped", ["1.5.2", "2.0.0-alpha"]);
		expect(
			failure(
				Release.make("unshaped", {
					packages: [member(unshaped)],
					change: ProjectChange,
					version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
				}).plan({
					packages: [{ package: unshaped, previous: "2.0.0-alpha", changes: [timeout] }],
				}),
			).reason,
		).toBe("PrereleaseContext");
	});
});

// Each history ends at the stated previous version, so planned versions are new to it.
const upTo = (ids: ReadonlyArray<string>, previous: string) =>
	ids.slice(0, ids.indexOf(previous) + 1);

const planLines = (input: {
	readonly unchanged: "align" | "drift";
	readonly a: { readonly previous: string };
	readonly b: { readonly previous: string };
}) => {
	const a = packageWith(
		"@acme/a",
		upTo(["1.5.2", "2.0.0-beta.0", "2.0.0-beta.1", "2.0.0-beta.2"], input.a.previous),
	);
	const b = packageWith(
		"@acme/b",
		upTo(["1.5.2", "2.0.0-beta.0", "1.6.0-beta.0"], input.b.previous),
	);

	return Release.make("lines", {
		packages: [member(a), member(b)],
		change: ProjectChange,
		version: SemVerStrategy.make({
			bump: (change) => change.metadata.bump,
			unchanged: input.unchanged,
		}),
	}).plan({
		input: { pre: { tag: "beta", continue: true } },
		packages: [
			{ package: a, changes: [headers], ...input.a },
			{ package: b, changes: [headers], ...input.b },
		],
	});
};
const placed = (plan: Release.Plan<any, SemVerStrategy.Details>) =>
	plan.versions.map(
		(planned) => `${planned.package}@${planned.version.id}#${planned.details?.line?.counter}`,
	);

describe("prerelease lines across a group", () => {
	it("lets a package without a line take the shared version in an aligned group", () => {
		expect(
			placed(
				success(
					planLines({
						unchanged: "align",
						a: { previous: "2.0.0-beta.1" },
						b: { previous: "1.5.2" },
					}),
				),
			),
		).toEqual(["@acme/a@2.0.0-beta.2#2", "@acme/b@2.0.0-beta.2#2"]);
	});

	it("gives each package its own counter on the line in a drifting group", () => {
		expect(
			placed(
				success(
					planLines({
						unchanged: "drift",
						a: { previous: "2.0.0-beta.1" },
						b: { previous: "1.5.2" },
					}),
				),
			),
		).toEqual(["@acme/a@2.0.0-beta.2#2", "@acme/b@2.0.0-beta.0#0"]);
		expect(
			placed(
				success(
					planLines({
						unchanged: "drift",
						a: { previous: "2.0.0-beta.2" },
						b: { previous: "2.0.0-beta.0" },
					}),
				),
			),
		).toEqual(["@acme/a@2.0.0-beta.3#3", "@acme/b@2.0.0-beta.1#1"]);
	});

	it("still refuses different lines in one calculation", () => {
		expect(
			failure(
				planLines({
					unchanged: "drift",
					a: { previous: "2.0.0-beta.1" },
					b: {
						previous: "1.6.0-beta.0",
					},
				}),
			).reason,
		).toBe("PrereleaseContext");
	});
});

describe("build metadata", () => {
	it("is refused by the SemVer strategy only", () => {
		const built = packageWith("@acme/built", ["1.5.2+build.3"]);
		const strategy = Release.make("built", {
			packages: [member(built)],
			change: ProjectChange,
			version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
		});
		expect(
			failure(
				strategy.plan({
					packages: [{ package: built, previous: "1.5.2+build.3", changes: [headers] }],
				}),
			).reason,
		).toBe("InvalidVersion");

		// Build metadata is refused by the SemVer strategy, not by the planner: a literal
		// target is decoded by the SemVer scheme, which accepts it, and passes through.
		const literal = success(
			strategy.plan({
				version: "1.6.0+build.4",
				packages: [{ package: built, previous: "1.5.2+build.3", changes: [headers] }],
			}),
		);
		expect(summary(literal)).toEqual(["@acme/built@1.6.0+build.4<1.5.2+build.3"]);
	});
});

const groupOf = (...packages: ReadonlyArray<Package.Package>) =>
	Release.make("previous", {
		packages: packages.map(member),
		change: ProjectChange,
		version: SemVerStrategy.make({ bump: (change) => change.metadata.bump }),
	});

describe("previous versions in plan input", () => {
	const v152 = Version.make("1.5.2", { changes: [] });
	const branched = Package.make("@acme/branched", {
		history: History.make({
			versions: [
				v152,
				Version.make("2.0.0", { previous: v152, changes: [] }),
				Version.make("1.5.3", { previous: v152, changes: [] }),
			],
			migrations: [],
		}),
	});
	const chain = packageWith("@acme/chain", ["1.5.0", "1.5.2"]);
	const empty = packageWith("@acme/empty", []);

	it("takes a bare package's previous version from the single head and reports it", () => {
		const plan = success(
			groupOf(chain).plan({ packages: [{ package: chain, changes: [retries] }] }),
		);
		const unchanged = success(groupOf(chain).plan({ packages: [chain] }));

		expect(summary(plan)).toEqual(["@acme/chain@1.6.0<1.5.2"]);
		expect(plan.versions[0]?.previousFrom).toBe("history-head");
		expect(plan.explanations[0]).toBe(
			"@acme/chain: no previous stated; using the only head of its history, 1.5.2.",
		);
		expect(unchanged.unchanged).toEqual([
			{
				package: "@acme/chain",
				version: "1.5.2",
				reason: "no-changes",
				previousFrom: "history-head",
			},
		]);
		expect(Release.heads(branched).map((version) => version.id)).toEqual(["2.0.0", "1.5.3"]);
	});

	it("refuses several heads and empty histories, naming every package at once", () => {
		const twoHeads = packageWith("@acme/other", ["1.0.0"]);
		const another = Package.make("@acme/forked", {
			history: History.make({
				versions: [
					...twoHeads.history.versions,
					Version.make("1.1.0", { previous: twoHeads.history.versions[0], changes: [] }),
					Version.make("1.0.1", { previous: twoHeads.history.versions[0], changes: [] }),
				],
				migrations: [],
			}),
		});

		expect(
			failure(
				groupOf(branched, another, chain).plan({ packages: [branched, another, chain] }),
			),
		).toMatchObject({
			reason: "PreviousRequired",
			subjects: ["@acme/branched", "2.0.0", "1.5.3", "@acme/forked", "1.1.0", "1.0.1"],
		});
		expect(
			success(
				groupOf(branched).plan({
					packages: [{ package: branched, previous: "1.5.3", changes: [headers] }],
				}),
			).versions[0]?.previousFrom,
		).toBe("stated");
		expect(failure(groupOf(empty).plan({ packages: [empty] }))).toMatchObject({
			reason: "NoPrevious",
			subjects: ["@acme/empty"],
		});
	});

	it("continues from a prerelease head", () => {
		const pre = packageWith("@acme/pre", ["1.5.2", "2.0.0-rc.0"]);
		const plan = success(
			groupOf(pre).plan({
				input: { pre: { tag: "rc", continue: true } },
				packages: [{ package: pre, changes: [headers] }],
			}),
		);

		expect(summary(plan)).toEqual(["@acme/pre@2.0.0-rc.1<2.0.0-rc.0"]);
		expect(plan.explanations[0]).toBe(
			"@acme/pre: no previous stated; using the only head of its history, 2.0.0-rc.0.",
		);
	});

	it("refuses a planned version that already exists anywhere in the history", () => {
		expect(
			failure(
				groupOf(branched).plan({
					packages: [{ package: branched, previous: "1.5.2", changes: [headers] }],
				}),
			),
		).toMatchObject({ reason: "ExistingVersion", subjects: ["@acme/branched", "1.5.3"] });
	});
});

describe("custom strategies and forks", () => {
	it("keeps a custom strategy's version verbatim", () => {
		const solo = packageWith("@acme/custom", ["1.5.2"]);
		const custom = (version: string) =>
			Release.make("custom", {
				packages: [member(solo)],
				change: ProjectChange,
				version: VersionStrategy.make<ProjectMetadata, SemVerStrategy.Version>({
					name: "fixed",
					scheme: SemVerStrategy.scheme,
					calculate: () => ({ version: SemVer.parseUnsafe(version), unchanged: "drift" }),
				}),
			}).plan({ packages: [{ package: solo, changes: [headers] }] });

		expect(summary(success(custom("2.0.0-beta.7")))).toEqual([
			"@acme/custom@2.0.0-beta.7<1.5.2",
		]);
		expect(summary(success(custom("2.0.0-beta.7+build.9")))).toEqual([
			"@acme/custom@2.0.0-beta.7+build.9<1.5.2",
		]);
	});

	it("allows releasing beside later versions and notes the fork", () => {
		const v152 = Version.make("1.5.2", { changes: [] });
		const ahead = Package.make("@acme/ahead", {
			history: History.make({
				versions: [v152, Version.make("1.5.3", { previous: v152, changes: [] })],
				migrations: [],
			}),
		});
		const plan = success(
			groupOf(ahead).plan({
				packages: [{ package: ahead, previous: "1.5.2", changes: [retries] }],
			}),
		);

		expect(summary(plan)).toEqual(["@acme/ahead@1.6.0<1.5.2"]);
		expect(plan.explanations).toContain(
			"Note: @acme/ahead@1.5.2 already has later versions (1.5.3); 1.6.0 forks beside them. Check the manifest or previous version if this is not intended.",
		);
	});
});
