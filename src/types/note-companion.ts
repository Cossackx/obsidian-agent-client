export interface TextRange {
	start: number;
	end: number;
}

/** Exact text captured from a single vault-relative Markdown source. */
export interface SourceSnapshot {
	path: string;
	text: string;
	capturedAt: number;
}
