// Changelog entries in the default Changesets format, without commit hashes.
export default {
	getReleaseLine: async (changeset) => {
		const [firstLine, ...futureLines] = changeset.summary
			.split("\n")
			.map((line) => line.trimEnd());
		return [`- ${firstLine}`, ...futureLines.map((line) => `  ${line}`)].join("\n");
	},
	getDependencyReleaseLine: async (_changesets, dependenciesUpdated) => {
		if (dependenciesUpdated.length === 0) return "";
		return [
			"- Updated dependencies",
			...dependenciesUpdated.map(({ name, newVersion }) => `  - ${name}@${newVersion}`),
		].join("\n");
	},
};
