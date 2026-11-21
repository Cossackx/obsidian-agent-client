import type {
	CompanionState,
	ContextItem,
	SourceSnapshot,
} from "../types/note-companion";
import { headingRanges } from "./context-builder";

export function emptyCompanion(sessionId: string): CompanionState {
	return {
		version: 1,
		sessionId,
		items: [],
		draft: "",
		destination: null,
		operations: [],
		sent: [],
	};
}

export function consumeSubmittedItems(
	state: CompanionState,
	sentItemIds: readonly string[],
): CompanionState {
	const consumed = new Set(sentItemIds);
	return {
		...state,
		items: state.items
			.filter(
				(item) => item.lifetime === "session" || !consumed.has(item.id),
			)
			.map((item) =>
				item.selectionEdit && consumed.has(item.id)
					? { ...item, selectionEdit: undefined }
					: item,
			),
	};
}

/** Remove one item; removing the last item for the followed note also dismisses the follow. */
export function removeItem(
	state: CompanionState,
	itemId: string | undefined,
	followPath: string | undefined,
): CompanionState {
	const removed = state.items.find((item) => item.id === itemId);
	const items = state.items.filter((item) => item.id !== itemId);
	return {
		...state,
		followDismissed:
			state.followDismissed ||
			(!!removed &&
				removed.source.path === followPath &&
				!items.some((item) => item.source.path === followPath)),
		items,
	};
}

export function putItem(
	state: CompanionState,
	item: ContextItem,
): CompanionState {
	const existing = state.items.findIndex(
		(candidate) => candidate.id === item.id,
	);
	return {
		...state,
		items:
			existing < 0
				? [...state.items, item]
				: state.items.map((candidate, index) =>
						index === existing ? item : candidate,
					),
	};
}

export function moveItem(
	state: CompanionState,
	id: string,
	delta: -1 | 1,
): CompanionState {
	const items = [...state.items];
	const index = items.findIndex((item) => item.id === id);
	const next = index + delta;
	if (index < 0 || next < 0 || next >= items.length) return state;
	[items[index], items[next]] = [items[next], items[index]];
	return { ...state, items };
}

/** Re-captures an item from fresh note bytes; passages must be re-selected. */
export function refreshItem(
	item: ContextItem,
	source: SourceSnapshot,
): Pick<ContextItem, "source" | "scope" | "status"> {
	let scope = item.scope;
	if (scope.kind === "passage")
		throw new Error("Capture a changed passage again from the editor.");
	if (scope.kind === "heading") {
		const old = scope;
		const row = headingRanges(source.text).find(
			(entry) =>
				entry.heading === old.heading &&
				entry.occurrence === old.occurrence,
		);
		if (!row) throw new Error("The heading no longer exists.");
		scope = { kind: "heading", ...row };
	}
	return { source, scope, status: undefined };
}
