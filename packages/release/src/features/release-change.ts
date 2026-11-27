import { Change } from "deltafold";
import type { Bump } from "./semver-strategy.ts";

export { Bump } from "./semver-strategy.ts";

/** @since 0.0.1 */
export type Metadata = { readonly bump: Bump };

/**
 * Convenience wrapper over `Change.define`; any `Change.define` factory works with
 * release groups.
 *
 * @example
 * ```ts
 * const ProjectChange = ReleaseChange.define<{ readonly area: "api" | "docs" }>();
 * const retries = ProjectChange.make("add-retries", { bump: "minor", area: "api" })`
 * 	Add a retry limit option.
 * `;
 * ```
 *
 * @since 0.0.1
 */
export const define = <Extra extends object = {}>(): Change.Definition<Extra & Metadata> =>
	Change.define<Extra & Metadata>();

/** @since 0.0.1 */
export const make = define().make;
