// The package compiles without DOM or Node.js types, so it declares the globals it uses.
// They merge with the full declarations in consumer projects.

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
