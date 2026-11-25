import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect } from "effect";

import { TypeScript } from "@deltafold/typescript";
import manifest from "../package.json" with { type: "json" };
import * as PackageConfig from "../src/configs/package.ts";
import { CompilerUnavailable } from "../src/workspace.ts";

/** Recovers from `ReadFailed` by tag. */
const recover = (effect: Effect.Effect<never, TypeScript.ReadFailed | TypeScript.WriteFailed>) =>
	effect.pipe(Effect.catchTag("@deltafold/typescript/ReadFailed", () => Effect.succeed(1)));

describe("@deltafold/typescript package", () => {
	it("names the package as package.json does", () => {
		expect(PackageConfig.name).toBe(manifest.name);
	});

	it("tags every error with the package name", () => {
		expect(
			new TypeScript.TransformFailed({ actionId: "a", root: "/", failures: [] })._tag,
		).toBe("@deltafold/typescript/TransformFailed");
		expect(new TypeScript.EditRejected({ path: "a.ts", reason: "r", ranges: [] })._tag).toBe(
			"@deltafold/typescript/EditRejected",
		);
		expect(new CompilerUnavailable({ cause: undefined })._tag).toBe(
			"@deltafold/typescript/CompilerUnavailable",
		);

		expectTypeOf<
			TypeScript.EditRejected["_tag"]
		>().toEqualTypeOf<"@deltafold/typescript/EditRejected">();
		expectTypeOf<
			TypeScript.SyntaxErrors["_tag"]
		>().toEqualTypeOf<"@deltafold/typescript/SyntaxErrors">();
		expectTypeOf<
			TypeScript.TransformFailed["_tag"]
		>().toEqualTypeOf<"@deltafold/typescript/TransformFailed">();
		expectTypeOf<
			TypeScript.WriteFailed["_tag"]
		>().toEqualTypeOf<"@deltafold/typescript/WriteFailed">();
		expectTypeOf<
			TypeScript.ReadFailed["_tag"]
		>().toEqualTypeOf<"@deltafold/typescript/ReadFailed">();
		expectTypeOf<
			TypeScript.CompilerFailed["_tag"]
		>().toEqualTypeOf<"@deltafold/typescript/CompilerFailed">();
		expectTypeOf<
			CompilerUnavailable["_tag"]
		>().toEqualTypeOf<"@deltafold/typescript/CompilerUnavailable">();
	});

	it("narrows the error channel with Effect.catchTag", () => {
		expectTypeOf(recover).returns.toEqualTypeOf<
			Effect.Effect<number, TypeScript.WriteFailed>
		>();
	});
});
