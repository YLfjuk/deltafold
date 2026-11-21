import manifest from "../../package.json" with { type: "json" };

/** The package name from `package.json`, for identifiers and generated-file headers. */
export const name = manifest.name;

/** The package version from `package.json`, recorded in generated-file headers. */
export const version = manifest.version;
