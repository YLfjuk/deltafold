// Tests inspect signals. These declarations extend the package's minimal AbortSignal and
// AbortController declarations in @types/abort-signal.d.ts.

interface AbortSignal {
	readonly reason: unknown;
	throwIfAborted(): void;
}
