// Files are decoded with TextDecoder so that a byte order mark survives. The package
// compiles without DOM or Node.js types, so it declares the part it uses.

interface TextDecoder {
	decode(input?: Uint8Array): string;
}

declare var TextDecoder: {
	prototype: TextDecoder;
	new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};
