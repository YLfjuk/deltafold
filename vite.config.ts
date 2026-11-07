import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		useTabs: true,
		tabWidth: 4,
		printWidth: 100,
		semi: true,
		singleQuote: false,
		jsxSingleQuote: false,
		quoteProps: "as-needed",
		bracketSpacing: true,
		trailingComma: "all",
		arrowParens: "always",
		endOfLine: "lf",
		sortImports: {
			ignoreCase: true,
			newlinesBetween: true,
			sortSideEffects: false,
			partitionByComment: false,
			partitionByNewline: false,
			order: "asc",
			customGroups: [
				{
					groupName: "react",
					elementNamePattern: ["react", "react-**"],
				},
				{
					groupName: "scope",
					elementNamePattern: ["deltafold", "deltafold/**", "@deltafold/**"],
				},
			],
			internalPattern: ["@/"],
			groups: [
				"side_effect",
				"builtin",
				"external",
				"react",
				"scope",
				{
					newlinesBetween: false,
				},
				["internal", "subpath"],
				{
					newlinesBetween: false,
				},
				["parent", "sibling", "index"],
				["style", "side_effect_style"],
				"unknown",
			],
		},
		sortPackageJson: {
			sortScripts: false,
		},
		ignorePatterns: [
			"**/routeTree.gen.ts",
			"**/CHANGELOG.md",
			".agents/skills/**",
			".claude/**",
			"pnpm-lock.yaml",
			"skills-lock.json",
			// Design input is kept verbatim until it is consolidated into maintained docs.
			"notes/**",
		],
	},
	lint: {
		plugins: ["typescript", "unicorn", "oxc", "import", "vitest"],
		categories: {
			correctness: "error",
			suspicious: "error",
		},
		rules: {
			// Effect data types use `_tag` as their discriminant.
			"no-underscore-dangle": ["error", { allow: ["_tag"] }],
			// @effect/vitest adds Effect-aware test blocks.
			"vitest/no-standalone-expect": [
				"error",
				{
					additionalTestBlockFunctions: [
						"it.effect",
						"it.live",
						"it.scoped",
						"it.scopedLive",
						"it.flakyTest",
						"it.layer",
						"it.prop",
					],
				},
			],
		},
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
});
