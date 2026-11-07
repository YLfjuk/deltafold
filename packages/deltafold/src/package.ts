/**
 * Packages give a history its identity. Changelog documents and other modules read the
 * package name from here instead of repeating it.
 *
 * @packageDocumentation
 */
import { Predicate } from "effect";

import type * as Action from "./action.ts";
import type { History } from "./history.ts";

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
 */
export const make = <A extends Action.Any>(
	name: string,
	options: { readonly history: History<A> },
): Package<A> => ({ _tag: "Package", name, history: options.history });

export const isPackage = (value: unknown): value is Package<any> =>
	Predicate.isTagged(value, "Package");
