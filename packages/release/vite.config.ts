import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite-plus";

import baseTsConfig from "../../tsconfig.base.json" with { type: "json" };

const {
	compilerOptions: {
		customConditions,
		customConditions: [devExports],
	},
} = baseTsConfig;

export default defineConfig({
	resolve: {
		conditions: [...customConditions, ...defaultClientConditions],
	},
	// Top-level resolve.conditions does not reach the Vitest server environment.
	ssr: {
		resolve: {
			conditions: [...customConditions, ...defaultServerConditions],
		},
	},
	pack: {
		entry: {
			index: "src/index.ts",
		},
		format: ["esm"],
		platform: "neutral",
		dts: true,
		sourcemap: true,
		exports: {
			devExports,
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
