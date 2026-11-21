import type { CompanionState, ContextItem } from "../types/note-companion";
import { isNotePath } from "./context-builder";
import { putItem } from "./companion-state";

export function noteDropPaths(paths: readonly string[]) {
	return [...new Set(paths.filter(isNotePath))];
}

/** Import a drag as next-turn snapshots; never replace a pin or a passage. */
export function stageDroppedNotes(
	old: CompanionState,
	items: readonly ContextItem[],
) {
	const fullNotes = new Set(
		old.items
			.filter(
				(row) =>
					row.role !== "destination" && row.scope.kind === "note",
			)
			.map((row) => row.source.path),
	);
	let state = old;
	for (const item of items) {
		if (fullNotes.has(item.source.path)) continue;
		state = putItem(state, item);
		fullNotes.add(item.source.path);
	}
	return state;
}

/** Keep independent attachment and note routes alive on mixed vault drops. */
export async function routeVaultDrop<File, Attachment>(
	drag: { notes: { path: string }[]; files: File[]; skippedCount: number },
	route: {
		stage: (paths: string[]) => Promise<void>;
		convert: (files: File[]) => Promise<Attachment[]>;
		attach: (files: Attachment[]) => void;
		notice: (message: string) => void;
	},
) {
	if (drag.skippedCount) route.notice("Folders cannot be attached.");
	const notes = noteDropPaths(drag.notes.map((note) => note.path));
	await Promise.all([
		(async () => {
			try {
				if (notes.length) await route.stage(notes);
			} catch (error) {
				route.notice(
					error instanceof Error
						? error.message
						: "Could not stage dropped notes.",
				);
			}
		})(),
		(async () => {
			try {
				if (drag.files.length)
					route.attach(await route.convert(drag.files));
			} catch {
				route.notice("Could not attach dropped files.");
			}
		})(),
	]);
}
