import manifest from "../../package.json" with { type: "json" };

/**
 * Hardcoded rather than read from `package.json` so error tags and type IDs keep literal
 * types; keep in sync with `package.json`.
 */
export const name = "@deltafold/release";

export const version = manifest.version;
