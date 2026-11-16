import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Order, Result, SemVer } from "effect";

import {
	Release,
	ReleaseFiles,
	SemVerStrategy,
	VersionScheme,
	VersionStrategy,
	type PlanError,
} from "@deltafold/release";
import { History, Package, Version } from "deltafold";
import {
	headers,
	ProjectChange,
	retries,
	timeout,
	type ProjectMetadata,
} from "./__fixtures__/packages.ts";

const success = <A>(result: Result.Result<A, PlanError>): A => {
	if (Result.isFailure(result))
		throw new Error(`${result.failure.reason}: ${result.failure.message}`);

	return result.success;
};

const failure = <A>(result: Result.Result<A, PlanError>): PlanError => {
	if (Result.isSuccess(result)) throw new Error("expected a planning failure");

	return result.failure;
};

const historyOf = (ids: ReadonlyArray<string>) => {
	const versions: Array<Version.Version> = [];
	for (const id of ids)
		versions.push(Version.make(id, { previous: versions.at(-1), changes: [] }));

	return History.make({ versions, migrations: [] });
};

// Literal names give each package its own type.
const widgets = Package.make("@acme/widgets", { history: historyOf(["1.5.2"]) });
const react = Package.make("@acme/widgets-react", { history: historyOf(["1.5.2"]) });
const site = Package.make("@acme/site", { history: historyOf(["2026.10.0"]) });
const stranger = Package.make("@acme/stranger", { history: historyOf(["1.0.0"]) });

const semver = SemVerStrategy.make<ProjectMetadata>({ bump: (change) => change.metadata.bump });
const calendar = VersionStrategy.make<ProjectMetadata, SemVerStrategy.Version>({
	name: "calendar",
	scheme: SemVerStrategy.scheme,
	calculate: ({ participants }) => ({
		version: SemVer.make({ major: 2026, minor: 10 + participants.length, patch: 0 }),
	}),
});

const group = Release.make("widgets", {
	change: ProjectChange,
	version: semver,
	packages: [
		{
			package: widgets,
			files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }),
		},
		{ package: react, files: ReleaseFiles.at("packages/react", { manifest: "package.json" }) },
		{
			package: site,
			files: ReleaseFiles.at("apps/site", { manifest: "package.json" }),
			version: calendar,
		},
	],
});

describe("plan input types", () => {
	it("types input per level and keeps per-package strategies to their registration", () => {
		const plan = success(
			group.plan({
				input: { pre: { tag: "beta", continue: false } },
				packages: [{ package: widgets, changes: [retries] }, react, site],
			}),
		);
		expect(plan.versions.map((planned) => planned.version.id)).toEqual([
			"1.6.0-beta.0",
			"1.6.0-beta.0",
		]);
		// SemVer details are typed on the plan.
		expectTypeOf(plan.versions[0]?.details).toEqualTypeOf<SemVerStrategy.Details | undefined>();
		expect(plan.versions[0]?.details?.line?.tag).toBe("beta");

		const overridden = success(
			group.plan({
				packages: [
					{
						package: widgets,
						changes: [retries],
						version: semver,
						input: { target: "3.0.0" },
					},
					react,
					{ package: site, changes: [headers] },
				],
			}),
		);
		expect(
			overridden.versions.map((planned) => `${planned.package}@${planned.version.id}`),
		).toEqual(["@acme/widgets@3.0.0", "@acme/site@2026.11.0"]);

		group.plan({
			packages: [
				// @ts-expect-error shared packages take the plan's input.
				{ package: widgets, input: { pre: { tag: "beta", continue: true } } },
				react,
				site,
			],
		});
		group.plan({
			packages: [
				widgets,
				react,
				// @ts-expect-error calendar takes no input.
				{ package: site, input: { target: "1.0.0" } },
			],
		});
		group.plan({
			packages: [
				widgets,
				react,
				// @ts-expect-error an override keeps the registered strategy's input type.
				{ package: site, version: semver },
			],
		});
		// @ts-expect-error unregistered packages are not plan entries.
		group.plan({ packages: [widgets, react, site, stranger] });
	});

	it("names the package in the error for input on a shared package", () => {
		type Entry = Parameters<
			typeof group.plan<readonly [{ readonly package: typeof widgets }]>
		>[0];
		expectTypeOf<NonNullable<Entry["packages"][0]["input"]>>().toEqualTypeOf<
			Release.SharedInputError<"@acme/widgets">
		>();
	});

	it("matches a package only by its registered type", () => {
		const loaded: Package.Package = widgets;
		// @ts-expect-error a package typed by a non-literal name matches no registration.
		group.plan({ packages: [{ package: loaded, changes: [retries] }, react, site] });
		expect(loaded.name).toBe("@acme/widgets");
	});

	it("gives strategies without a schema `undefined` input", () => {
		expectTypeOf<VersionStrategy.InputOf<typeof calendar>>().toEqualTypeOf<undefined>();
		const solo = Release.make("site", {
			change: ProjectChange,
			version: calendar,
			packages: [
				{
					package: site,
					files: ReleaseFiles.at("apps/site", { manifest: "package.json" }),
				},
			],
		});
		// @ts-expect-error an object literal is not undefined.
		solo.plan({ input: {}, packages: [site] });
	});
});

describe("schemes beyond SemVer", () => {
	it("plans with any scheme: decoding, ordering, downgrades, and encoding", () => {
		const build = VersionScheme.make<number>({
			name: "build-number",
			decode: (id) =>
				/^\d+$/.test(id)
					? Result.succeed(Number(id))
					: Result.fail(`"${id}" is not a build number.`),
			encode: String,
			order: Order.Number,
		});
		const next = VersionStrategy.make<
			ProjectMetadata,
			number,
			{ readonly step?: number } | undefined,
			{ readonly ancestry: number | undefined }
		>({
			name: "next-build",
			scheme: build,
			calculate: ({ participants, input }) => ({
				version:
					Math.max(...participants.map((participant) => participant.previous)) +
					(input?.step ?? 1),
				details: { ancestry: participants[0]?.ancestry.length },
			}),
		});
		const app = Package.make("app", { history: historyOf(["1", "7"]) });
		const builds = Release.make("app", {
			change: ProjectChange,
			version: next,
			packages: [
				{ package: app, files: ReleaseFiles.at("apps/app", { manifest: "package.json" }) },
			],
		});

		const plan = success(
			builds.plan({ input: { step: 2 }, packages: [{ package: app, changes: [headers] }] }),
		);
		expect(plan.versions.map((planned) => planned.version.id)).toEqual(["9"]);
		expect(plan.versions[0]?.details).toEqual({ ancestry: 2 });
		expect(
			failure(builds.plan({ version: "3", packages: [{ package: app, changes: [headers] }] }))
				.reason,
		).toBe("Downgrade");
		expect(
			failure(
				builds.plan({ version: "v9", packages: [{ package: app, changes: [headers] }] }),
			),
		).toMatchObject({
			reason: "InvalidVersion",
		});
	});

	it("refuses versions a strategy returns for packages outside its calculation", () => {
		const stray = VersionStrategy.make<ProjectMetadata, SemVerStrategy.Version>({
			name: "stray",
			scheme: SemVerStrategy.scheme,
			calculate: () => ({
				version: SemVer.parseUnsafe("2.0.0"),
				versions: [{ package: "@acme/elsewhere", version: SemVer.parseUnsafe("3.0.0") }],
			}),
		});
		const solo = Release.make("solo", {
			change: ProjectChange,
			version: stray,
			packages: [
				{
					package: widgets,
					files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }),
				},
			],
		});
		expect(
			failure(solo.plan({ packages: [{ package: widgets, changes: [timeout] }] })),
		).toMatchObject({
			reason: "InvalidStrategyResult",
			subjects: ["stray", "@acme/elsewhere"],
		});
	});
});

const validate = (value: unknown) => semver.input?.["~standard"].validate(value);

describe("the SemVer strategy", () => {
	it("uses Effect's SemVer type and validates input with its schema", () => {
		expectTypeOf<SemVerStrategy.Version>().toEqualTypeOf<SemVer.SemVer>();

		expect(validate({ pre: { tag: "beta", continue: true }, target: "3.0.0" })).toMatchObject({
			value: { pre: { tag: "beta", continue: true }, target: "3.0.0" },
		});
		expect(validate({ pre: { tag: "beta" } })).toHaveProperty("issues");
	});

	it("encodes lines as strings for output", () => {
		const line = SemVerStrategy.lineOf(SemVer.parseUnsafe("2.0.0-beta.3"), [
			SemVer.parseUnsafe("2.0.0-beta.3"),
			SemVer.parseUnsafe("1.5.2"),
		]);
		expect(line && JSON.stringify(SemVerStrategy.encodeLine(line))).toBe(
			'{"baseline":"1.5.2","target":"2.0.0","tag":"beta","counter":3}',
		);
	});
});
