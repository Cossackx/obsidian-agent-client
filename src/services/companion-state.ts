import type { CompanionState, ContextItem } from "../types/note-companion";

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
		items: state.items.filter(
			(item) => item.lifetime === "session" || !consumed.has(item.id),
		),
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
