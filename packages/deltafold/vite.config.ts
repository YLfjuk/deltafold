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
	ssr: {
		resolve: {
			conditions: [...customConditions, ...defaultServerConditions],
		},
	},
	pack: {
		entry: {
			index: "src/index.ts",
			"changelog/index": "src/changelog/index.ts",
			markdown: "src/renderers/markdown.ts",
			html: "src/renderers/html.ts",
		},
		format: ["esm"],
		platform: "neutral",
		dts: true,
		sourcemap: true,
		exports: {
			devExports,
		},
		publint: {
			strict: true,
		},
		attw: {
			profile: "esm-only",
			level: "error",
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
