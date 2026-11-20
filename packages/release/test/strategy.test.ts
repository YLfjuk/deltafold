import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Order, Result, SemVer } from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";

import {
	Release,
	ReleaseFiles,
	SemVerStrategy,
	VersionScheme,
	VersionStrategy,
	PlanError,
} from "@deltafold/release";
import { History, Package, Version } from "deltafold";
import {
	headers,
	ProjectChange,
	retries,
	timeout,
	type ProjectMetadata,
} from "./__fixtures__/packages.ts";

const schemaOf = <I>(
	validate: (value: unknown) => StandardSchemaV1.Result<I> | Promise<StandardSchemaV1.Result<I>>,
): StandardSchemaV1<unknown, I> => ({ "~standard": { version: 1, vendor: "test", validate } });

type Step = { readonly step?: number } | undefined;

const stepOf = (value: unknown): number | undefined =>
	typeof value === "object" && value !== null && "step" in value && typeof value.step === "number"
		? value.step
		: undefined;

const stepInput = (value: unknown): Step => {
	const step = stepOf(value);
	return step === undefined ? undefined : { step };
};

const buildNumber = VersionScheme.make<number>({
	name: "build-number",
	decode: (id) =>
		/^\d+$/.test(id)
			? Result.succeed(Number(id))
			: Result.fail(`"${id}" is not a build number.`),
	encode: String,
	order: Order.Number,
});

const ids = (plan: Release.Plan) => plan.versions.map((planned) => planned.version.id);

const success = <A>(result: Result.Result<A, PlanError>): A => {
	if (Result.isFailure(result))
		throw new Error(`${result.failure.reason}: ${result.failure.message}`);

	return result.success;
};

const failure = <A>(result: Result.Result<A, PlanError>): PlanError => {
	if (Result.isSuccess(result)) throw new Error("expected a planning failure");

	return result.failure;
};

const historyOf = (history: ReadonlyArray<string>) => {
	const versions: Array<Version.Version> = [];
	for (const id of history)
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
		expect(
			// @ts-expect-error an object literal is not undefined.
			failure(solo.plan({ input: {}, packages: [{ package: site, changes: [headers] }] })),
		).toMatchObject({ reason: "InvalidInput", subjects: ["calendar"] });
		expect(() =>
			// @ts-expect-error an input type needs a schema behind it.
			VersionStrategy.make<ProjectMetadata, number, { readonly step: number }>({
				name: "unchecked",
				scheme: buildNumber,
				calculate: () => ({ version: 1 }),
			}),
		).not.toThrow();
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
			input: schemaOf((value) => ({ value: stepInput(value) })),
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
		// A literal keeps its spelling even when the scheme would encode it differently.
		const literal = success(
			builds.plan({ version: "08", packages: [{ package: app, changes: [headers] }] }),
		);
		expect(literal.versions.map((planned) => planned.version.id)).toEqual(["08"]);
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

	it("refuses a bump that is not major, minor, or patch", () => {
		const loose = Release.make("widgets", {
			change: ProjectChange,
			version: SemVerStrategy.make<ProjectMetadata>({ bump: () => JSON.parse('"huge"') }),
			packages: [
				{
					package: widgets,
					files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }),
				},
			],
		});
		expect(
			failure(loose.plan({ packages: [{ package: widgets, changes: [retries] }] })),
		).toMatchObject({ reason: "InvalidBump", subjects: ["add-retries"] });
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

// Type-checked only; never run.
const resolveTyped = () =>
	Effect.gen(function* () {
		const resolved = yield* ReleaseFiles.resolve(group, {
			input: { pre: { tag: "beta", continue: false } },
			packages: [
				{
					package: widgets,
					version: semver,
					input: { target: "3.0.0" },
					changes: [retries],
				},
				react,
				site,
			],
		});
		const [first] = resolved.input.packages;
		expectTypeOf(first.input).toEqualTypeOf<{ readonly target: "3.0.0" }>();
		expectTypeOf(first.changes).toEqualTypeOf<readonly [typeof retries]>();
		return resolved;
	});

describe("resolve keeps selection fields", () => {
	it("types each entry's own fields after resolution", () => {
		expect(typeof resolveTyped).toBe("function");
	});
});

describe("strategy input validation", () => {
	const app = Package.make("app", { history: historyOf(["7"]) });
	const files = ReleaseFiles.at("apps/app", { manifest: "package.json" });
	// Rejects steps below 1 and fills in a default step of 2.
	const positive = schemaOf<Step>((value) => {
		const step = stepOf(value) ?? 2;
		return step < 1
			? { issues: [{ message: "must be at least 1", path: ["step"] }] }
			: { value: { step } };
	});
	const stepper = (input: StandardSchemaV1<unknown, Step>) =>
		VersionStrategy.make<ProjectMetadata, number, Step>({
			name: "stepper",
			scheme: VersionScheme.make<number>({
				name: "build-number",
				decode: (id) => Result.succeed(Number(id)),
				encode: String,
				order: Order.Number,
			}),
			input,
			calculate: ({ participants, input: given }) => ({
				version: (participants[0]?.previous ?? 0) + (given?.step ?? 100),
			}),
		});
	const shared = (input: StandardSchemaV1<unknown, Step>) =>
		Release.make("app", {
			change: ProjectChange,
			version: stepper(input),
			packages: [{ package: app, files }],
		});
	const own = (input: StandardSchemaV1<unknown, Step>) =>
		Release.make("app", {
			change: ProjectChange,
			version: calendar,
			packages: [{ package: app, files, version: stepper(input) }],
		});

	it("passes the schema's output to the strategy", () => {
		expect(
			ids(
				success(
					shared(positive).plan({ packages: [{ package: app, changes: [headers] }] }),
				),
			),
		).toEqual(["9"]);
		expect(
			ids(success(own(positive).plan({ packages: [{ package: app, changes: [headers] }] }))),
		).toEqual(["9"]);
	});

	it("refuses input the schema rejects, at the plan and per package", () => {
		expect(
			failure(
				shared(positive).plan({
					input: { step: 0 },
					packages: [{ package: app, changes: [headers] }],
				}),
			),
		).toMatchObject({
			reason: "InvalidInput",
			message: "The plan's input is not valid input for stepper: step: must be at least 1",
			subjects: ["stepper"],
		});
		expect(
			failure(
				own(positive).plan({
					packages: [{ package: app, changes: [headers], input: { step: 0 } }],
				}),
			),
		).toMatchObject({
			reason: "InvalidInput",
			message: "app's input is not valid input for stepper: step: must be at least 1",
		});
	});

	it("refuses asynchronous validation", () => {
		const later = schemaOf<Step>(async (value) => ({ value: stepInput(value) }));
		for (const release of [shared(later), own(later)]) {
			expect(
				failure(release.plan({ packages: [{ package: app, changes: [headers] }] })),
			).toMatchObject({ reason: "InvalidInput", subjects: ["stepper"] });
		}
	});

	it("refuses any thenable result, such as a Promise from another realm", () => {
		// A Promise from another realm has that realm's prototype, so `instanceof` misses it.
		const foreignPromise = () => {
			const promise = Promise.resolve<StandardSchemaV1.Result<Step>>({ value: { step: 4 } });
			// The stand-in prototype is a thenable on purpose: it plays the other realm's Promise.
			// oxlint-disable-next-line unicorn/no-thenable, typescript/unbound-method
			Object.setPrototypeOf(promise, { then: Promise.prototype.then });
			return promise;
		};
		expect(foreignPromise()).not.toBeInstanceOf(Promise);
		const foreign = schemaOf<Step>(foreignPromise);
		expect(
			failure(shared(foreign).plan({ packages: [{ package: app, changes: [headers] }] })),
		).toMatchObject({ reason: "InvalidInput", subjects: ["stepper"] });
	});

	it("does not read input for a literal version", () => {
		expect(
			ids(
				success(
					shared(positive).plan({
						version: "20",
						input: { step: 0 },
						packages: [{ package: app, changes: [headers] }],
					}),
				),
			),
		).toEqual(["20"]);
	});

	it("requires input when the strategy's input type does not accept undefined", () => {
		const required = VersionStrategy.make<ProjectMetadata, number, { readonly step: number }>({
			name: "required",
			scheme: VersionScheme.make<number>({
				name: "build-number",
				decode: (id) => Result.succeed(Number(id)),
				encode: String,
				order: Order.Number,
			}),
			input: schemaOf<{ readonly step: number }>((value) => {
				const step = stepOf(value);
				return step === undefined
					? { issues: [{ message: "step is required" }] }
					: { value: { step } };
			}),
			calculate: ({ participants, input }) => ({
				version: (participants[0]?.previous ?? 0) + input.step,
			}),
		});
		const sharedRequired = Release.make("app", {
			change: ProjectChange,
			version: required,
			packages: [{ package: app, files }],
		});
		expect(
			// @ts-expect-error the shared strategy requires input.
			failure(sharedRequired.plan({ packages: [{ package: app, changes: [headers] }] }))
				.reason,
		).toBe("InvalidInput");
		expect(
			ids(
				success(
					sharedRequired.plan({
						input: { step: 3 },
						packages: [{ package: app, changes: [headers] }],
					}),
				),
			),
		).toEqual(["10"]);

		const ownRequired = Release.make("app", {
			change: ProjectChange,
			version: calendar,
			packages: [{ package: app, files, version: required }],
		});
		// @ts-expect-error a bare package cannot carry the input its strategy requires.
		expect(failure(ownRequired.plan({ packages: [app] })).reason).toBe("InvalidInput");
		expect(
			// @ts-expect-error the package's own strategy requires input.
			failure(ownRequired.plan({ packages: [{ package: app, changes: [headers] }] })).reason,
		).toBe("InvalidInput");
	});
});

describe("strategy boundaries", () => {
	const onLine = Package.make("@acme/beta-two", {
		history: historyOf(["1.0.0", "2.0.0-beta.1"]),
	});
	const otherLine = Package.make("@acme/beta-three", {
		history: historyOf(["1.0.0", "3.0.0-beta.1"]),
	});
	const lines = Release.make("lines", {
		change: ProjectChange,
		version: semver,
		packages: [
			{
				package: onLine,
				files: ReleaseFiles.at("packages/two", { manifest: "package.json" }),
			},
			{
				package: otherLine,
				files: ReleaseFiles.at("packages/three", { manifest: "package.json" }),
			},
		],
	});
	const changed = [
		{ package: onLine, changes: [headers] },
		{ package: otherLine, changes: [headers] },
	] as const;

	it("refuses to start one line from participants on different lines", () => {
		expect(
			failure(
				lines.plan({
					input: { pre: { tag: "rc", continue: false }, target: "4.0.0" },
					packages: changed,
				}),
			),
		).toMatchObject({
			reason: "PrereleaseContext",
			subjects: ["@acme/beta-two", "@acme/beta-three"],
		});
	});

	it("refuses a SemVer target with build metadata, but keeps literal versions exact", () => {
		const solo = Release.make("solo", {
			change: ProjectChange,
			version: semver,
			packages: [
				{
					package: widgets,
					files: ReleaseFiles.at("packages/widgets", { manifest: "package.json" }),
				},
			],
		});
		expect(
			failure(
				solo.plan({
					input: { target: "2.0.0+build.1" },
					packages: [{ package: widgets, changes: [timeout] }],
				}),
			),
		).toMatchObject({ reason: "InvalidVersion", subjects: ["2.0.0+build.1"] });
		const literal = success(
			solo.plan({
				version: "2.0.0+build.1",
				packages: [{ package: widgets, changes: [timeout] }],
			}),
		);
		expect(literal.versions.map((planned) => planned.version.id)).toEqual(["2.0.0+build.1"]);
	});

	it("refuses a derived line baseline with build metadata", () => {
		const built = Package.make("@acme/built", {
			history: historyOf(["1.0.0+build", "2.0.0-beta.0"]),
		});
		const solo = Release.make("built", {
			change: ProjectChange,
			version: semver,
			packages: [
				{
					package: built,
					files: ReleaseFiles.at("packages/built", { manifest: "package.json" }),
				},
			],
		});
		expect(
			failure(
				solo.plan({
					input: { pre: { tag: "beta", continue: true } },
					packages: [{ package: built, changes: [headers] }],
				}),
			),
		).toMatchObject({ reason: "InvalidVersion", subjects: ["1.0.0+build"] });
	});

	it("reports a PlanError thrown by a custom strategy as an invalid result", () => {
		const forged = VersionStrategy.make<ProjectMetadata, SemVerStrategy.Version>({
			name: "forged",
			scheme: SemVerStrategy.scheme,
			calculate: () => {
				throw new PlanError({ reason: "Downgrade", message: "fake", subjects: [] });
			},
		});
		const solo = Release.make("solo", {
			change: ProjectChange,
			version: forged,
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
			message: "forged threw instead of refusing: fake",
			subjects: ["forged"],
		});
	});
});
