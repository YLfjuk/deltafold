import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import manifest from "../package.json" with { type: "json" };
import * as PackageConfig from "../src/configs/package.ts";

describe("@deltafold/cli package", () => {
	it("keeps package config in sync with package.json", () => {
		expect(PackageConfig.name).toBe(manifest.name);
		expect(PackageConfig.version).toBe(manifest.version);
		expectTypeOf<typeof PackageConfig.name>().toEqualTypeOf<"@deltafold/cli">();
	});
});
