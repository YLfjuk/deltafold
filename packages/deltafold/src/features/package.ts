import { Function, Pipeable, Predicate } from "effect";

import type * as Action from "../foundation/action.ts";
import type * as Observer from "./execution/observer.ts";
import type { History } from "./planning/history.ts";

/**
 * A modeled package. `O` is the union of its attached observers.
 *
 * @since @next
 */
export type Package<
	A extends Action.Any = Action.Any,
	O extends Observer.Any = never,
> = Pipeable.Pipeable & {
	readonly _tag: "Package";
	/** The name of the modeled package, for example `@acme/widgets`. */
	readonly name: string;
	readonly history: History<A>;
	/**
	 * Observers attached with `withObserver`, in attachment order. Attaching them causes no
	 * events; pass them to the executor's `observers` option.
	 */
	readonly observers: ReadonlyArray<O>;
};

/**
 * Any package, with or without observers. Annotating a parameter with it accepts every
 * package but loses the observers' Effect services; keep `A` and `O` generic to preserve
 * them.
 *
 * @since @next
 */
export type Any = Package<any, any>;

const build = <A extends Action.Any, O extends Observer.Any>(fields: {
	readonly name: string;
	readonly history: History<A>;
	readonly observers: ReadonlyArray<O>;
}): Package<A, O> =>
	Object.assign(Object.create(Pipeable.Prototype), { _tag: "Package", ...fields });

/**
 * Defines the modeled package. It holds no renderer settings, release metadata, or
 * handlers.
 *
 * @example
 * ```ts
 * export const widgets = Package.make("@acme/widgets", { history });
 * ```
 *
 * @since @next
 */
export const make = <A extends Action.Any>(
	name: string,
	options: { readonly history: History<A> },
): Package<A> => build({ name, history: options.history, observers: [] });

/**
 * Returns a new package with the observer attached after the existing ones. The original
 * package is unchanged. Reuse an observed package for observers shared by every run, such
 * as logging, or attach one per run for progress.
 *
 * @example
 * ```ts
 * const observed = widgets.pipe(Package.withObserver(Observer.sync(render)));
 * await Executor.runPromise(plan, { handlers, observers: observed.observers });
 * ```
 *
 * @since @next
 */
export const withObserver: {
	<O2 extends Observer.Any>(
		observer: O2,
	): <A extends Action.Any, O extends Observer.Any>(self: Package<A, O>) => Package<A, O | O2>;
	<A extends Action.Any, O extends Observer.Any, O2 extends Observer.Any>(
		self: Package<A, O>,
		observer: O2,
	): Package<A, O | O2>;
} = Function.dual(2, (self: Any, observer: Observer.Any): Any =>
	build({ name: self.name, history: self.history, observers: [...self.observers, observer] }),
);

/** @since @next */
export const isPackage = (value: unknown): value is Any => Predicate.isTagged(value, "Package");
