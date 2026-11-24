// The package compiles without DOM or Node.js types, so it declares the two globals it
// uses: the AbortSignal that Promise transforms receive, and TextDecoder, which reads
// files without dropping a byte order mark the way Effect's readFileString does. These
// declarations merge with the full DOM or Node.js ones in consumer projects and are not
// published.

interface AbortSignal {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}

interface TextDecoder {
	decode(input?: Uint8Array): string;
}

declare var TextDecoder: {
	prototype: TextDecoder;
	new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};
