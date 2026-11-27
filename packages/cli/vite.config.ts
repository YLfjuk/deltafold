import { defaultServerConditions, defineConfig } from "vite-plus";

import baseTsConfig from "../../tsconfig.base.json" with { type: "json" };

const {
	compilerOptions: {
		customConditions,
		customConditions: [devExports],
	},
} = baseTsConfig;

export default defineConfig({
	// Tests run deltafold from its source.
	ssr: {
		resolve: {
			conditions: [...customConditions, ...defaultServerConditions],
		},
	},
	pack: {
		entry: { bin: "src/domains/node/bin.ts" },
		format: ["esm"],
		platform: "node",
		dts: false,
		sourcemap: true,
		exports: {
			devExports,
			// Without a name, the bin is named after the package ("cli").
			bin: { deltafold: "./src/domains/node/bin.ts" },
			// Otherwise the only entry becomes the package's "." export, and importing the
			// package would run the CLI.
			exclude: ["bin"],
		},
		publint: {
			strict: true,
		},
		// No attw: the package ships a bin and no types, which attw reports as an error.
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
