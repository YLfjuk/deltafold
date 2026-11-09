import { defineConfig } from "vite-plus";

export default defineConfig({
	pack: {
		entry: { bin: "src/domains/node/bin.ts" },
		format: ["esm"],
		platform: "node",
		dts: false,
		sourcemap: true,
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
