// The package compiles without DOM or Node.js types, so it declares the two globals it
// uses. Promise transforms receive an AbortSignal. TextDecoder decodes files and keeps a
// byte order mark, which Effect's readFileString drops. These declarations merge with the
// DOM or Node.js ones in consumer projects, and the package does not publish them.

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
