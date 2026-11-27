import type { Release } from "../../../foundation/version.ts";
import type { Changelog } from "../../documents/changelog.ts";
import type * as Handler from "../../execution/handler.ts";
import type * as Observer from "../../execution/observer.ts";
import type { Package } from "../../package.ts";

/** Handler types are erased; `Command.make` carries them. */
export type Definition = {
	readonly name: string;
	readonly description: string;
	readonly package: Package;
	readonly changelog: Changelog<any>;
	readonly releases: (() => ReadonlyArray<Release<any>>) | undefined;
	readonly handlers: (() => Promise<ReadonlyArray<Handler.Any>>) | undefined;
	readonly observers: (() => Promise<ReadonlyArray<Observer.Any>>) | undefined;
};
