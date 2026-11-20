export interface SourcePosition {
	line: number;
	ch: number;
}

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

export type ContextScope =
	| { kind: "note" }
	| { kind: "heading"; heading: string; occurrence: number; range: TextRange }
	| { kind: "passage"; range: TextRange };
export interface ContextItem {
	id: string;
	source: SourceSnapshot;
	scope: ContextScope;
	role: "working" | "reference" | "destination";
	lifetime: "turn" | "session";
	annotation?: string;
	status?: "changed" | "missing" | "renamed";
}
export type DestinationAnchor =
	| { path: string; kind: "end" }
	| { path: string; kind: "heading"; heading: string; occurrence: number }
	| { path: string; kind: "range"; range: TextRange };
export interface NoteEditProposal {
	id: string;
	path: string;
	target?: DestinationAnchor;
	mode: "append" | "insert" | "replace" | "create";
	before: string | null;
	after: string;
	sourceMessageId: string;
}
export interface WriteReceipt {
	operationId: string;
	path: string;
	status:
		| "pending"
		| "verified"
		| "not-applied"
		| "conflict"
		| "unknown"
		| "undo-pending"
		| "undone";
}
export interface CompanionState {
	version: 1;
	sessionId: string;
	items: ContextItem[];
	draft: string;
	compact?: boolean;
	favourites?: string[];
	destination: DestinationAnchor | null;
	operations: { proposal: NoteEditProposal; receipt: WriteReceipt }[];
	sent: {
		id: string;
		sources: {
			path: string;
			text: string;
			capturedAt: number;
			scope: ContextScope;
			originalLength?: number;
			currentPath?: string;
			positions?: { from: SourcePosition; to: SourcePosition };
		}[];
	}[];
}
