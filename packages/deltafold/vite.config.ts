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
	// Top-level resolve.conditions does not reach the Vitest server environment. Without
	// this, tests resolve dist instead of the development source condition.
	ssr: {
		resolve: {
			conditions: [...customConditions, ...defaultServerConditions],
		},
	},
	pack: {
		entry: {
			index: "src/index.ts",
			changelog: "src/features/documents/index.ts",
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
