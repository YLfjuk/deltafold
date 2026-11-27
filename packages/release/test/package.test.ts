import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect } from "effect";

import type { PlanError, VersionStrategy } from "@deltafold/release";
import manifest from "../package.json" with { type: "json" };
import * as PackageConfig from "../src/configs/package.ts";

const catchPlanError = (effect: Effect.Effect<void, PlanError>) =>
	effect.pipe(Effect.catchTag("@deltafold/release/PlanError", () => Effect.void));

describe("@deltafold/release package", () => {
	it("keeps package config in sync with package.json and literal tag types", () => {
		expect(PackageConfig.name).toBe(manifest.name);
		expect(PackageConfig.version).toBe(manifest.version);
		expectTypeOf<PlanError["_tag"]>().toEqualTypeOf<"@deltafold/release/PlanError">();
		expectTypeOf<
			typeof VersionStrategy.TypeId
		>().toEqualTypeOf<"~@deltafold/release/VersionStrategy">();
		expectTypeOf(catchPlanError).returns.toEqualTypeOf<Effect.Effect<void>>();
	});
});
