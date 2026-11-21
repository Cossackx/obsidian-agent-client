import type { ContextItem } from "../types/note-companion";
export function deriveCompanionStatus(input: {
	connected: boolean;
	busy: boolean;
	pendingPermission: boolean;
	hasHistory: boolean;
	initializing: boolean;
	error?: string;
}) {
	if (input.pendingPermission) return "needs-approval";
	if (input.error) return "error";
	if (input.initializing) return "connecting";
	if (!input.connected)
		return input.hasHistory ? "history-only" : "disconnected";
	return input.busy ? "working" : "connected";
}

export const companionStatusLabel = {
	"needs-approval": "Needs approval",
	error: "Connection or turn error",
	connecting: "Connecting",
	"history-only": "History only · not connected",
	disconnected: "Disconnected",
	working: "Working",
	connected: "Connected",
} as const;

export interface ComposerChip {
	key: string;
	kind: "following" | "item";
	path: string;
	/** Short honest scope: what the next send carries for this chip. */
	scope: string;
	itemId?: string;
	pinned: boolean;
	selectionEdit?: true;
	annotation?: string;
	status?: string;
}

/**
 * One visible representation per active note: an explicit item for the
 * active path replaces the follow chip, and a dismissed follow stays off
 * for this conversation whatever note becomes active.
 */
export function composerChips(input: {
	items: readonly ContextItem[];
	activePath?: string;
	followDismissed: boolean;
}): { chips: ComposerChip[]; following: boolean } {
	const chips: ComposerChip[] = input.items
		.filter((item) => item.role !== "destination")
		.map((item) => ({
			key: item.id,
			kind: "item",
			path: item.source.path,
			itemId: item.id,
			pinned: item.lifetime === "session",
			...(item.selectionEdit && { selectionEdit: item.selectionEdit }),
			status: item.status,
			annotation: item.annotation,
			scope:
				item.scope.kind === "note"
					? `whole note · ${item.role}`
					: item.scope.kind === "heading"
						? `heading “${item.scope.heading}” · ${item.role}`
						: `selected passage · ${item.role}`,
		}));
	const following =
		!!input.activePath &&
		!input.followDismissed &&
		!input.items.some((item) => item.source.path === input.activePath);
	if (following && input.activePath)
		chips.unshift({
			key: "following",
			kind: "following",
			path: input.activePath,
			pinned: false,
			scope: "following active note · path only",
		});
	return { chips, following };
}
