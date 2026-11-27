// The workspace packages compile against the ES2022 library alone, so no DOM or Node.js
// types declare AbortSignal or AbortController. Without these declarations, a signal
// parameter typed by Effect loses its type and TypeScript reports nothing. They declare
// only the members the packages use, merge with the DOM or Node.js declarations in
// consumer projects, and are not published.

interface AbortSignal {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}

interface AbortController {
	readonly signal: AbortSignal;
	abort(reason?: unknown): void;
}

declare var AbortController: {
	prototype: AbortController;
	new (): AbortController;
};
