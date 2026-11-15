import { Predicate } from "effect";

import type * as Action from "../foundation/action.ts";
import type { History } from "./planning/history.ts";

/** @since 0.0.1 */
export type Package<A extends Action.Any = Action.Any> = {
	readonly _tag: "Package";
	/** The name of the modeled package, for example `@acme/widgets`. */
	readonly name: string;
	readonly history: History<A>;
};

/**
 * Defines the modeled package. It holds no renderer settings, release metadata, or
 * handlers.
 *
 * @example
 * ```ts
 * export const widgets = Package.make("@acme/widgets", { history });
 * ```
 *
 * @since 0.0.1
 */
export const make = <A extends Action.Any>(
	name: string,
	options: { readonly history: History<A> },
): Package<A> => ({ _tag: "Package", name, history: options.history });

/** @since 0.0.1 */
export const isPackage = (value: unknown): value is Package<any> =>
	Predicate.isTagged(value, "Package");
