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
	const revisions = useRef(new Map<string, number>());
	const failed = useRef(
		new Map<
			string,
			{ id: string; kind: string; revision: number; change: Change }
		>(),
	);
	const restore = useRef(restoreDraft);
	restore.current = restoreDraft;
	const save = useCallback(
		async (
			id: string,
			change: Change,
			kind = "context",
			retryRevision?: number,
		) => {
			const key = JSON.stringify([id, kind]);
			const revision =
				retryRevision ?? (revisions.current.get(key) ?? 0) + 1;
			if (
				retryRevision !== undefined &&
				revisions.current.get(key) !== retryRevision
			)
				return;
			revisions.current.set(key, revision);
			try {
				const result = await storage.update(id, change);
				if (revisions.current.get(key) === revision)
					failed.current.delete(key);
				if (active.current === id) {
					setState(result);
					if (
						![...failed.current.values()].some(
							(entry) => entry.id === id,
						)
					)
						setWarning("");
				}
			} catch (error) {
				if (active.current === id)
					setWarning(
						error instanceof Error
							? error.message
							: "Companion state could not be saved",
					);
				if (revisions.current.get(key) === revision)
					failed.current.set(key, { id, kind, revision, change });
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
			return save(
				pending.id,
				(old) => ({ ...old, draft: pending.text }),
				"draft",
			);
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
					const pendingDraft = failed.current.get(
						JSON.stringify([sessionId, "draft"]),
					);
					if (pendingDraft)
						setWarning("A draft change has not been saved.");
					restore.current(
						pendingDraft?.change(saved ?? emptyCompanion(sessionId))
							.draft ??
							saved?.draft ??
							"",
					);
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
			void flush();
		};
	}, [sessionId, storage, flush, version]);
	const update = (change: Change, kind?: string) =>
		sessionId ? save(sessionId, change, kind) : Promise.resolve();
	return {
		state: state?.sessionId === sessionId ? state : null,
		warning,
		update,
		flush,
		setDraft(text: string) {
			if (!sessionId || state?.sessionId !== sessionId) return;
			draft.current = { id: sessionId, text };
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = setTimeout(() => void flush(), 350);
		},
		confirmed(prepared: PreparedContext, id: string) {
			return update((old) => {
				if (old.sent.some((turn) => turn.id === id)) return old;
				return {
					...consumeSubmittedItems(old, prepared.sentItemIds),
					sent: [...old.sent, { id, sources: prepared.sources }],
				};
			}, `sent:${id}`);
		},
		async refresh() {
			if (!sessionId) return;
			const saved = await storage.load(sessionId);
			if (active.current === sessionId)
				setState(saved ?? emptyCompanion(sessionId));
		},
		async retry() {
			setWarning("");
			if (!sessionId) return;
			const pending = [...failed.current.values()].filter(
				(entry) => entry.id === sessionId,
			);
			await flush();
			for (const entry of pending)
				await save(sessionId, entry.change, entry.kind, entry.revision);
			if (!pending.length) bump((n) => n + 1);
		},
	};
}
