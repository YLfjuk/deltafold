import { Change } from "deltafold";
import type { Bump } from "./semver-strategy.ts";

export type { Bump } from "./semver-strategy.ts";

/**
 * The metadata `ReleaseChange` requires.
 *
 * @since @next
 */
export type Metadata = { readonly bump: Bump };

/**
 * Defines a change factory whose metadata has a `bump` field and the extra fields of
 * `Extra`. It is a convenience: any `Change.define` factory works with release groups.
 *
 * @example
 * ```ts
 * const ProjectChange = ReleaseChange.define<{ readonly area: "api" | "docs" }>();
 * const retries = ProjectChange.make("add-retries", { bump: "minor", area: "api" })`
 * 	Add a retry limit option.
 * `;
 * ```
 *
 * @since @next
 */
export const define = <Extra extends object = {}>(): Change.Definition<Extra & Metadata> =>
	Change.define<Extra & Metadata>();

/**
 * Declares a change with only bump metadata.
 *
 * @since @next
 */
export const make = define().make;
