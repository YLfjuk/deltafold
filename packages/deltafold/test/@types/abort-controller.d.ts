// Tests create and inspect signals. These declarations extend the package's minimal
// AbortSignal declarations in the root @types/abort-signal.d.ts.

interface AbortSignal {
	readonly reason: unknown;
	throwIfAborted(): void;
}
