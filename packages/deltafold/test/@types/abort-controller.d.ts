// Tests create and inspect signals. These declarations extend the package's minimal
// AbortSignal declarations in @types/abort-signal.d.ts.

interface AbortSignal {
	readonly reason: unknown;
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
