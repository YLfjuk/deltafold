import { Predicate } from "effect";

import type * as Action from "../foundation/action.ts";
import type { History } from "./planning/index.ts";

/**
 * `N` preserves a literal package name so tools can distinguish packages by type.
 *
 * @since 0.0.1
 */
export type Package<A extends Action.Any = Action.Any, N extends string = string> = {
	readonly _tag: "Package";
	readonly name: N;
	readonly history: History.History<A>;
};

/**
 * Holds no renderer settings, release metadata, or handlers.
 *
 * @example
 * ```ts
 * export const widgets = Package.make("@acme/widgets", { history });
 * ```
 *
 * @since 0.0.1
 */
export const make = <A extends Action.Any, const N extends string = string>(
	name: N,
	options: { readonly history: History.History<A> },
): Package<A, N> => ({ _tag: "Package", name, history: options.history });

/** @since 0.0.1 */
export const isPackage = (value: unknown): value is Package<any> =>
	Predicate.isTagged(value, "Package");
