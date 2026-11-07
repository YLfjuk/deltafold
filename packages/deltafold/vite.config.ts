import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite-plus";

import baseTsConfig from "../../tsconfig.base.json" with { type: "json" };

const {
	compilerOptions: {
		customConditions: [devExports],
	},
} = baseTsConfig;

if (devExports === undefined) {
	throw new Error("tsconfig.base.json must declare the development source condition.");
}

export default defineConfig({
	resolve: {
		conditions: [devExports, ...defaultClientConditions],
	},
	ssr: {
		resolve: {
			conditions: [devExports, ...defaultServerConditions],
		},
	},
	pack: {
		entry: ["src/index.ts"],
		format: ["esm"],
		platform: "neutral",
		dts: true,
		sourcemap: true,
		exports: {
			devExports,
		},
		publint: true,
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
