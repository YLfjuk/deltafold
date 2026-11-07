import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import * as deltafold from "deltafold";

describe("deltafold package", () => {
	it("resolves its own entry point through the development source condition", () => {
		expect(deltafold).toBeTypeOf("object");
	});

	it.effect("runs Effect tests under the test clock", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(Effect.as(Effect.sleep("1 hour"), "done"));
			yield* TestClock.adjust("1 hour");
			expect(yield* Fiber.join(fiber)).toBe("done");
		}),
	);
});
