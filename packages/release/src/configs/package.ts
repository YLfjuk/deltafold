import manifest from "../../package.json" with { type: "json" };

/**
 * The package name, kept in sync with `package.json` for literal types, identifiers,
 * error tags, and generated-file headers.
 */
export const name = "@deltafold/release";

/** The package version from `package.json`, recorded in generated-file headers. */
export const version = manifest.version;
