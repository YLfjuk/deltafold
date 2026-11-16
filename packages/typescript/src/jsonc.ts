/** Whether `path` names a JSON or JSONC file. */
export const isJsonPath = (path: string) => /\.jsonc?$/i.test(path);

const parses = (text: string) => {
	try {
		JSON.parse(text);

		return true;
	} catch {
		return false;
	}
};

/** The end of the string literal that starts at `start`, after its closing quote. */
const stringEnd = (text: string, start: number) => {
	let end = start + 1;
	while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;

	return end + 1;
};

/** Removes comments outside strings. Returns undefined for an unterminated block comment. */
const stripComments = (text: string) => {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index]!;
		if (char === '"') {
			const end = stringEnd(text, index);
			output += text.slice(index, end);
			index = end;
		} else if (char === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") index++;
		} else if (char === "/" && text[index + 1] === "*") {
			const end = text.indexOf("*/", index + 2);
			if (end === -1) return undefined;
			index = end + 2;
		} else {
			output += char;
			index++;
		}
	}

	return output;
};

/** Removes commas outside strings that only whitespace separates from `}` or `]`. */
const stripTrailingCommas = (text: string) => {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index]!;
		if (char === '"') {
			const end = stringEnd(text, index);
			output += text.slice(index, end);
			index = end;
			continue;
		}
		if (char === ",") {
			let next = index + 1;
			while (next < text.length && /\s/.test(text[next]!)) next++;
			if (text[next] === "}" || text[next] === "]") {
				index++;
				continue;
			}
		}
		output += char;
		index++;
	}

	return output;
};

/**
 * Removes comments and trailing commas outside strings, so the result parses as JSON
 * exactly when the input is valid JSON with comments.
 */
const stripJsonc = (text: string) => {
	const withoutComments = stripComments(text);

	return withoutComments === undefined ? undefined : stripTrailingCommas(withoutComments);
};

const parsesWithComments = (text: string) => {
	const stripped = stripJsonc(text);

	return stripped !== undefined && parses(stripped);
};

/**
 * Checks edited JSON against the dialect of the original: strict JSON stays strict, and
 * JSON with comments or trailing commas must still parse as such. Returns a reason when
 * the edited text does not parse.
 */
export const checkJson = (original: string, edited: string): string | undefined => {
	if (parses(original)) return parses(edited) ? undefined : "The edited JSON does not parse";

	return parsesWithComments(edited) ? undefined : "The edited JSON with comments does not parse";
};
