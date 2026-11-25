/**
 * Turn streamed assistant Markdown into short speakable chunks.
 * Code blocks, long paths and URLs are not read aloud.
 */

const CODE_PLACEHOLDER = "Code block omitted.";
const FENCE = "```";

/**
 * Extract the next speakable sentences from `text`, starting at `from`.
 * While streaming (`final` false) only complete sentences/lines are taken,
 * and nothing past an unclosed code fence. Returns the chunks and the new
 * offset to resume from.
 */
export function extractSpeakable(
	text: string,
	from: number,
	final: boolean,
): { chunks: string[]; next: number } {
	const chunks: string[] = [];
	let pos = from;
	while (pos < text.length) {
		const rest = text.slice(pos);
		const lead = rest.length - rest.trimStart().length;
		if (rest.startsWith(FENCE, lead)) {
			const close = rest.indexOf(FENCE, lead + FENCE.length);
			if (close < 0 && !final) break;
			chunks.push(CODE_PLACEHOLDER);
			pos = close < 0 ? text.length : pos + close + FENCE.length;
			continue;
		}
		// Sentence end followed by whitespace, a line break, or a code fence.
		const m = /[.!?](?=\s)|\n|```/.exec(rest);
		let end: number;
		if (m) end = m[0] === "\n" || m[0] === FENCE ? m.index : m.index + 1;
		else if (final) end = rest.length;
		else break;
		if (end === 0) {
			pos += 1; // lone newline
			continue;
		}
		const spoken = cleanForSpeech(rest.slice(0, end));
		if (spoken) chunks.push(spoken);
		pos += end;
	}
	return { chunks, next: pos };
}

/** Strip Markdown and unspeakable tokens from one sentence/line. */
export function cleanForSpeech(line: string): string {
	let s = line
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> label
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[note|alias]]
		.replace(/\[\[([^\]]+)\]\]/g, "$1")
		.replace(/`([^`]*)`/g, (_m, code: string) =>
			code.length <= 24 && !/[\\/]/.test(code) ? code : "",
		)
		.replace(/https?:\/\/\S+/g, "a link")
		// Long or multi-segment paths (C:\a\b, /a/b/c, a/b/c.md)
		.replace(/(?:[A-Za-z]:)?[\\/]?(?:[\w.-]+[\\/]){2,}[\w.-]*/g, "a path")
		.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/[*_~|]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!/[\p{L}\p{N}]/u.test(s)) s = "";
	return s;
}
