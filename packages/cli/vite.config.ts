import { defineConfig } from "vite-plus";

import baseTsConfig from "../../tsconfig.base.json" with { type: "json" };

const {
	compilerOptions: {
		customConditions: [devExports],
	},
} = baseTsConfig;

export default defineConfig({
	pack: {
		entry: { bin: "src/domains/node/bin.ts" },
		format: ["esm"],
		platform: "node",
		dts: false,
		sourcemap: true,
		exports: {
			devExports,
			bin: { deltafold: "./src/domains/node/bin.ts" },
			// The package is only the executable; importing it must not run the CLI.
			exclude: ["bin"],
		},
		publint: {
			strict: true,
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		// Tests start Node.js processes.
		testTimeout: 30_000,
	},
});
