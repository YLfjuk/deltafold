// The library targets ES2022 without DOM or Node types, but Promise handlers receive the
// AbortSignal that Effect.tryPromise creates. These declarations cover what the package
// uses. They merge with the full DOM or Node declarations in consumer projects, and are
// not part of the published bundle.

interface AbortSignal {
	readonly aborted: boolean;
	readonly reason: unknown;
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
	throwIfAborted(): void;
}

interface AbortController {
	readonly signal: AbortSignal;
	abort(reason?: unknown): void;
}

declare var AbortController: {
	prototype: AbortController;
	new (): AbortController;
};
