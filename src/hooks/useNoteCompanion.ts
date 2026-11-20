import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionState } from "../types/note-companion";
import type { PreparedContext } from "../services/context-builder";
import {
	consumeSubmittedItems,
	emptyCompanion,
} from "../services/companion-state";
import { useChatContext } from "../ui/ChatContext";

type Change = (state: CompanionState) => CompanionState;
export function useNoteCompanion(
	sessionId: string | null,
	restoreDraft: (draft: string) => void,
) {
	const { plugin } = useChatContext();
	const storage = plugin.companionStorage;
	const [state, setState] = useState<CompanionState | null>(null);
	const [warning, setWarning] = useState("");
	const [version, bump] = useState(0);
	const active = useRef(sessionId);
	active.current = sessionId;
	const draft = useRef<{ id: string; text: string } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const failed = useRef<{ id: string; change: Change }[]>([]);
	const restore = useRef(restoreDraft);
	restore.current = restoreDraft;
	const save = useCallback(
		async (id: string, change: Change) => {
			try {
				const result = await storage.update(id, change);
				if (active.current === id) setState(result);
			} catch (error) {
				if (active.current === id)
					setWarning(
						error instanceof Error
							? error.message
							: "Companion state could not be saved",
					);
				failed.current.push({ id, change });
			}
		},
		[storage],
	);
	const flush = useCallback(() => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
		const pending = draft.current;
		draft.current = null;
		if (pending)
			void save(pending.id, (old) => ({ ...old, draft: pending.text }));
	}, [save]);
	useEffect(() => {
		let cancelled = false;
		setState(null);
		setWarning("");
		if (sessionId)
			void storage.load(sessionId).then(
				(saved) => {
					if (cancelled) return;
					setState(saved ?? emptyCompanion(sessionId));
					restore.current(saved?.draft ?? "");
				},
				(error: unknown) => {
					if (!cancelled)
						setWarning(
							error instanceof Error
								? error.message
								: "Companion state unavailable",
						);
				},
			);
		const off = storage.subscribe((saved) => {
			if (!cancelled && saved.sessionId === sessionId) setState(saved);
		});
		return () => {
			cancelled = true;
			off();
			flush();
		};
	}, [sessionId, storage, flush, version]);
	const update = (change: Change) =>
		sessionId ? save(sessionId, change) : Promise.resolve();
	return {
		state: state?.sessionId === sessionId ? state : null,
		warning,
		update,
		flush,
		setDraft(text: string) {
			if (!sessionId || state?.sessionId !== sessionId) return;
			draft.current = { id: sessionId, text };
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = setTimeout(flush, 350);
		},
		confirmed(prepared: PreparedContext, id: string) {
			return update((old) => {
				if (old.sent.some((turn) => turn.id === id)) return old;
				return {
					...consumeSubmittedItems(old, prepared.sentItemIds),
					sent: [...old.sent, { id, sources: prepared.sources }],
				};
			});
		},
		async refresh() {
			if (!sessionId) return;
			const saved = await storage.load(sessionId);
			if (active.current === sessionId)
				setState(saved ?? emptyCompanion(sessionId));
		},
		async retry() {
			setWarning("");
			const pending = failed.current.filter(
				(entry) => entry.id === sessionId,
			);
			failed.current = failed.current.filter(
				(entry) => entry.id !== sessionId,
			);
			for (const entry of pending) await save(entry.id, entry.change);
			if (!pending.length) bump((n) => n + 1);
		},
	};
}
