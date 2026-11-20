import type { SavedSessionInfo } from "../types/session";
import type { CompanionStorage } from "./companion-storage";
import type { CompanionState } from "../types/note-companion";

export async function findNoteSessions(
	path: string,
	sessions: readonly SavedSessionInfo[],
	storage: CompanionStorage,
): Promise<{ session: SavedSessionInfo; companion: CompanionState }[]> {
	const result = [];
	for (const session of sessions) {
		const companion = await storage.load(session.sessionId);
		if (
			companion &&
			(companion.destination?.path === path ||
				companion.items.some((item) => item.source.path === path) ||
				companion.sent.some((turn) =>
					turn.sources.some((item) => item.path === path),
				))
		)
			result.push({ session, companion });
	}
	return result.sort((a, b) =>
		b.session.updatedAt.localeCompare(a.session.updatedAt),
	);
}

export function renameNoteAssociation(
	state: CompanionState,
	from: string,
	to: string,
): CompanionState {
	if (
		state.destination?.path !== from &&
		!state.items.some((item) => item.source.path === from) &&
		!state.sent.some((turn) =>
			turn.sources.some((source) => source.path === from),
		)
	)
		return state;
	return {
		...state,
		items: state.items.map((item) =>
			item.source.path === from
				? {
						...item,
						source: { ...item.source, path: to },
						status: "renamed",
					}
				: item,
		),
		destination:
			state.destination?.path === from
				? { ...state.destination, path: to }
				: state.destination,
		sent: state.sent.map((turn) => ({
			...turn,
			sources: turn.sources.map((source) =>
				source.path === from ? { ...source, path: to } : source,
			),
		})),
	};
}
