import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { Handler } from "deltafold";
import * as deltafold from "deltafold";
import manifest from "../package.json" with { type: "json" };
import * as PackageConfig from "../src/configs/package.ts";

describe("deltafold package", () => {
	it("resolves its own entry point through the development source condition", () => {
		expect(deltafold).toBeTypeOf("object");
	});

	it("keeps package config in sync with package.json and literal error tags", () => {
		expect(PackageConfig.name).toBe(manifest.name);
		expectTypeOf<
			Handler.VerificationFailed["_tag"]
		>().toEqualTypeOf<"deltafold/VerificationFailed">();
		const handled = Effect.fail(
			new Handler.VerificationFailed({ actionId: "a", kind: "k" }),
		).pipe(Effect.catchTag("deltafold/VerificationFailed", () => Effect.void));
		expectTypeOf(handled).toEqualTypeOf<Effect.Effect<void>>();
	});

	it.effect("runs Effect tests under the test clock", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(Effect.as(Effect.sleep("1 hour"), "done"));
			yield* TestClock.adjust("1 hour");
			expect(yield* Fiber.join(fiber)).toBe("done");
		}),
	);
});
