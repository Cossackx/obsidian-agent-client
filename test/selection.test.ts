import { expect, it } from "vitest";
import { extractSelection } from "../src/utils/selection";

it("partial_line_is_exact", () => {
	expect(
		extractSelection(
			"before TARGET after",
			{ line: 0, ch: 7 },
			{ line: 0, ch: 13 },
		),
	).toEqual({ text: "TARGET", range: { start: 7, end: 13 } });
});
it("preserves UTF-16 offsets and CRLF even with reversed endpoints", () => {
	expect(
		extractSelection("a🐙\r\nbc", { line: 1, ch: 1 }, { line: 0, ch: 1 }),
	).toEqual({ text: "🐙\r\nb", range: { start: 1, end: 6 } });
	expect(
		extractSelection("a\r\nb", { line: 0, ch: 1 }, { line: 1, ch: 0 }).text,
	).toBe("\r\n");
	expect(
		extractSelection("a\n", { line: 1, ch: 0 }, { line: 1, ch: 0 }).text,
	).toBe("");
});
it("rejects invalid positions rather than widening the excerpt", () => {
	expect(() =>
		extractSelection("a\r\nb", { line: 0, ch: 2 }, { line: 1, ch: 1 }),
	).toThrow(RangeError);
	expect(() =>
		extractSelection("a", { line: -1, ch: 0 }, { line: 0, ch: 1 }),
	).toThrow(RangeError);
});
