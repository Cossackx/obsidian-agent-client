import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionState, ContextItem } from "../types/note-companion";
import type { PreparedContext } from "../services/context-builder";
import {
	consumeSubmittedItems,
	emptyCompanion,
} from "../services/companion-state";
import { useChatContext } from "../ui/ChatContext";
import { CompanionMutationExpired } from "../services/companion-mutation";

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
	const draftEdit = useRef<object | null>(null);
	const loadedOwner = useRef<{ id: string | null; restored: boolean }>({
		id: sessionId,
		restored: false,
	});
	if (loadedOwner.current.id !== sessionId)
		loadedOwner.current = { id: sessionId, restored: false };
	const owner = loadedOwner.current;
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
			kind: string,
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
			// Tray adds are insertion intents, including multi-item batches.
			const isAdd = kind.startsWith("add:");
			let attempted: ContextItem[] = [];
			let retryChange = change;
			let readbackUnavailable = false;
			try {
				const result = isAdd
					? await storage.update(
							id,
							(old) => {
								const present = new Set(
									old.items.map((item) => item.id),
								);
								attempted = change(old).items.filter(
									(item) =>
										!present.has(item.id) &&
										!revisions.current.has(
											JSON.stringify([
												id,
												`remove:${item.id}`,
											]),
										),
								);
								return attempted.length
									? {
											...old,
											items: [...old.items, ...attempted],
										}
									: old;
							},
							(readback) => {
								readbackUnavailable = readback === undefined;
								const present = new Set(
									readback?.items.map((item) => item.id),
								);
								// An observed row is applied even if it later disappears.
								const remaining = readbackUnavailable
									? []
									: attempted.filter(
											(item) => !present.has(item.id),
										);
								retryChange = (old) => ({
									...old,
									items: [...old.items, ...remaining],
								});
							},
						)
					: await storage.update(id, change);
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
				if (error instanceof CompanionMutationExpired) {
					if (revisions.current.get(key) === revision)
						failed.current.delete(key);
					if (retryRevision === undefined) throw error;
					return;
				}
				if (active.current === id)
					setWarning(
						readbackUnavailable
							? "Could not verify added context. Refresh and re-add only missing items."
							: error instanceof Error
								? error.message
								: "Companion state could not be saved",
					);
				if (revisions.current.get(key) === revision)
					failed.current.set(key, {
						id,
						kind,
						revision,
						change: retryChange,
					});
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
		let observedSave = false;
		const editAtLoad = draftEdit.current;
		setState(null);
		setWarning("");
		if (sessionId)
			void storage.load(sessionId).then(
				(saved) => {
					if (cancelled) return;
					if (!observedSave)
						setState(saved ?? emptyCompanion(sessionId));
					const pendingDraft = failed.current.get(
						JSON.stringify([sessionId, "draft"]),
					);
					if (
						[...failed.current.values()].some(
							(entry) => entry.id === sessionId,
						)
					)
						setWarning("A companion change has not been saved.");
					if (
						owner.restored ||
						draftEdit.current !== editAtLoad ||
						draft.current?.id === sessionId
					) {
						owner.restored = true;
						return;
					}
					owner.restored = true;
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
			if (!cancelled && saved.sessionId === sessionId) {
				observedSave = true;
				setState(saved);
			}
		});
		return () => {
			cancelled = true;
			off();
			void flush();
		};
	}, [sessionId, storage, flush, version, owner]);
	const update = (change: Change, kind: string) =>
		sessionId && loadedOwner.current === owner
			? save(sessionId, change, kind)
			: Promise.resolve();
	return {
		state: state?.sessionId === sessionId ? state : null,
		warning,
		update,
		flush,
		setDraft(text: string) {
			if (!sessionId || loadedOwner.current !== owner) return;
			owner.restored = true;
			draftEdit.current = {};
			draft.current = { id: sessionId, text };
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = setTimeout(() => void flush(), 350);
		},
		confirmed(prepared: PreparedContext, id: string) {
			if (!sessionId) return Promise.resolve();
			// Receipt belongs to the originating turn even if its composer closed.
			return save(
				sessionId,
				(old) => {
					if (old.sent.some((turn) => turn.id === id)) return old;
					return {
						...consumeSubmittedItems(old, prepared.sentItemIds),
						sent: [...old.sent, { id, sources: prepared.sources }],
					};
				},
				`sent:${id}`,
			);
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
