// Effect's readFileString decodes with a TextDecoder that drops a leading byte order
// mark. The workspace decodes file bytes itself to keep it. These declarations cover
// what the package uses and merge with the full DOM or Node declarations.

interface TextDecoder {
	decode(input?: Uint8Array): string;
}

declare var TextDecoder: {
	prototype: TextDecoder;
	new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
};
