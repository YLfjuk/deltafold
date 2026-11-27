import { defaultServerConditions, defineConfig } from "vite-plus";

import baseTsConfig from "../../tsconfig.base.json" with { type: "json" };

const {
	compilerOptions: {
		customConditions,
		customConditions: [devExports],
	},
} = baseTsConfig;

export default defineConfig({
	ssr: {
		resolve: {
			conditions: [...customConditions, ...defaultServerConditions],
		},
	},
	pack: {
		entry: "src/domains/node/bin.ts",
		format: ["esm"],
		platform: "node",
		dts: false,
		sourcemap: true,
		exports: {
			devExports,
			bin: { deltafold: "./src/domains/node/bin.ts" },
			exclude: ["bin"],
		},
		publint: {
			strict: true,
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
