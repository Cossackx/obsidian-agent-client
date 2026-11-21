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
export type ContextQuote = {
	label: string;
	text: string;
	limit: "note" | "selection";
	source?: {
		path: string;
		capturedAt: number;
		scope: ContextScope;
		kind: "template" | "approved-destination";
	};
};

export interface ContextItem {
	id: string;
	source: SourceSnapshot;
	scope: ContextScope;
	role: "working" | "reference" | "destination";
	lifetime: "turn" | "session";
	/** This staged passage is the target of the next composer edit request. */
	selectionEdit?: true;
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
	/** User removed the auto-follow chip for this conversation. */
	followDismissed?: boolean;
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
			provenance?: "captured" | "mention" | "following";
			itemId?: string;
			role?: Exclude<ContextItem["role"], "destination">;
			annotation?: string;
			quoteKind?: "template" | "approved-destination";
			currentPath?: string;
			positions?: { from: SourcePosition; to: SourcePosition };
		}[];
	}[];
}
