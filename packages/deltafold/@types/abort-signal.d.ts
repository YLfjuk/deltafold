// The library targets ES2022 without DOM or Node types, but Promise handlers receive the
// AbortSignal that Effect.tryPromise creates, and runPromise accepts one for cancellation.
// Without these declarations, AbortSignal parameters silently become an error type. They
// cover what the package uses, merge with the full DOM or Node declarations in consumer
// projects, and are not part of the published bundle.

interface AbortSignal {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}
