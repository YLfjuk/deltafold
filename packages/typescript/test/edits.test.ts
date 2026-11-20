import { describe, expect, it } from "@effect/vitest";

import { applyEdits, splitByteOrderMark } from "../src/edits.ts";
import { EditRejected } from "../src/errors.ts";
import { checkJson } from "../src/jsonc.ts";

describe("applyEdits", () => {
	const text = "const a = 1;";

	it("applies edits that refer to the original text, in any order", () => {
		expect(
			applyEdits("f.ts", text, [
				{ pos: 10, end: 11, newText: "22" },
				{ pos: 6, end: 7, newText: "bb" },
			]),
		).toBe("const bb = 22;");
	});

	it("puts insertions before a replacement at the same offset, in returned order", () => {
		expect(
			applyEdits("f.ts", text, [
				{ pos: 6, end: 7, newText: "b" },
				{ pos: 6, end: 6, newText: "x" },
				{ pos: 6, end: 6, newText: "y" },
			]),
		).toBe("const xyb = 1;");
	});

	it("keeps identical replacements once and every identical insertion", () => {
		expect(
			applyEdits("f.ts", text, [
				{ pos: 6, end: 7, newText: "b" },
				{ pos: 6, end: 7, newText: "b" },
				{ pos: 12, end: 12, newText: "!" },
				{ pos: 12, end: 12, newText: "!" },
			]),
		).toBe("const b = 1;!!");
	});

	it("allows an insertion where a replacement ends", () => {
		expect(
			applyEdits("f.ts", text, [
				{ pos: 6, end: 7, newText: "b" },
				{ pos: 7, end: 7, newText: "c" },
			]),
		).toBe("const bc = 1;");
	});

	it("rejects overlapping edits and names both ranges", () => {
		const result = applyEdits("f.ts", text, [
			{ pos: 0, end: 7, newText: "" },
			{ pos: 6, end: 9, newText: "x" },
		]);

		if (!(result instanceof EditRejected))
			throw new Error(`Expected a rejection, got ${result}`);
		expect(result.ranges).toEqual([
			{ pos: 0, end: 7 },
			{ pos: 6, end: 9 },
		]);
	});

	it("rejects an insertion inside a replacement and different replacements of one range", () => {
		expect(
			applyEdits("f.ts", text, [
				{ pos: 0, end: 7, newText: "" },
				{ pos: 3, end: 3, newText: "x" },
			]),
		).toBeInstanceOf(EditRejected);
		expect(
			applyEdits("f.ts", text, [
				{ pos: 6, end: 7, newText: "b" },
				{ pos: 6, end: 7, newText: "c" },
			]),
		).toBeInstanceOf(EditRejected);
	});

	it("rejects edits outside the text", () => {
		for (const edit of [
			{ pos: -1, end: 0, newText: "" },
			{ pos: 3, end: 2, newText: "" },
			{ pos: 0, end: 13, newText: "" },
			{ pos: 0.5, end: 1, newText: "" },
		]) {
			expect(applyEdits("f.ts", text, [edit])).toBeInstanceOf(EditRejected);
		}
	});
});

describe("splitByteOrderMark", () => {
	it("splits a leading byte order mark", () => {
		expect(splitByteOrderMark("﻿a")).toEqual({ bom: "﻿", text: "a" });
		expect(splitByteOrderMark("a﻿")).toEqual({ bom: "", text: "a﻿" });
	});
});

describe("checkJson", () => {
	it("keeps strict JSON strict", () => {
		expect(checkJson('{"a":1}', '{"b":1}')).toBeUndefined();
		expect(checkJson('{"a":1}', '{"b":1,}')).toBe("The edited JSON does not parse");
	});

	it("accepts comments and trailing commas when the original had them", () => {
		const original = '{\n\t// note\n\t"a": 1,\n}';
		expect(
			checkJson(original, '{\n\t// note\n\t"b": 1, /* c */\n\t"s": "// not a comment",\n}'),
		).toBeUndefined();
		expect(checkJson(original, '{\n\t"b": 1,,\n}')).toBe(
			"The edited JSON with comments does not parse",
		);
		expect(checkJson(original, '{ "b": 1 /* open')).toBe(
			"The edited JSON with comments does not parse",
		);
	});

	it("keeps tokens apart where a block comment separated them", () => {
		expect(checkJson('{"a":1,}', '{"a":1/*c*/2,}')).toBe(
			"The edited JSON with comments does not parse",
		);
		expect(checkJson('{"a":1,}', '{"a":/*c*/1,}')).toBeUndefined();
	});
});
