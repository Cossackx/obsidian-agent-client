import type { TextRange } from "../types/note-companion";

type Position = { line: number; ch: number };

/** Editor columns are UTF-16 units. CRLF is one line break but two units. */
export function extractSelection(
	text: string,
	from: Position,
	to: Position,
): { text: string; range: TextRange } {
	const lines = text.split(/\r\n|\n|\r/);
	const starts = [0];
	for (const match of text.matchAll(/\r\n|\n|\r/g))
		starts.push(match.index + match[0].length);
	const offset = ({ line, ch }: Position) => {
		if (
			!Number.isInteger(line) ||
			!Number.isInteger(ch) ||
			lines[line] === undefined ||
			ch < 0 ||
			ch > lines[line].length
		)
			throw new RangeError("Selection is outside the captured note");
		return starts[line] + ch;
	};
	const a = offset(from),
		b = offset(to);
	const start = Math.min(a, b),
		end = Math.max(a, b);
	return { text: text.slice(start, end), range: { start, end } };
}

export const normalizeLineEndings = (value: string) =>
	value.replace(/\r\n|\r/g, "\n");

export function selectionPositions(buffer: string, range: TextRange) {
	function position(offset: number) {
		const lines = normalizeLineEndings(buffer.slice(0, offset)).split("\n");
		return { line: lines.length - 1, ch: lines.at(-1)?.length ?? 0 };
	}
	return { from: position(range.start), to: position(range.end) };
}

/** Map editor offsets into the exact saved preimage, tolerating EOL representation only. */
export function mapStoredRange(
	buffer: string,
	stored: string,
	range: TextRange,
): TextRange {
	if (normalizeLineEndings(buffer) !== normalizeLineEndings(stored))
		throw new Error(
			"The editor has unsaved changes. Save before placing a reply.",
		);
	if (range.start < 0 || range.end < range.start || range.end > buffer.length)
		throw new RangeError("Invalid editor range");
	const { from, to } = selectionPositions(buffer, range);
	return extractSelection(stored, from, to).range;
}

/** Do not split a Unicode surrogate pair at a truncation boundary. */
export function truncateText(text: string, limit: number): string {
	if (limit >= text.length) return text;
	const end = Math.max(0, Math.floor(limit));
	const last = text.charCodeAt(end - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}
