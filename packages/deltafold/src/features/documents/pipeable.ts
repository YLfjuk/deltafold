import { Pipeable } from "effect";

/** Creates a value with Effect's `pipe` method. */
export const pipeable = <T extends object>(fields: T): T & Pipeable.Pipeable =>
	Object.assign(Object.create(Pipeable.Prototype), fields);
