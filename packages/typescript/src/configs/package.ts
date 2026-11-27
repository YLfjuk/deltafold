/**
 * The package name, which every error tag includes. It is a literal because a JSON
 * import types `name` as `string`, which would widen each tag to `${string}/ReadFailed`
 * and stop `Effect.catchTag` from narrowing. A test checks it against `package.json`.
 */
export const name = "@deltafold/typescript";
