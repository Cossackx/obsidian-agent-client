import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SetStateAction } from "react";
import type { AttachedFile } from "../types/chat";
import { useNoteCompanion } from "./useNoteCompanion";

const EMPTY_ATTACHMENTS: AttachedFile[] = [];

/** Owns controlled input across async sends, attachment reads and view lifetimes. */
export function useCompanionComposer(sessionId: string | null) {
	const mounted = useRef(false);
	const leaseRef = useRef({ id: sessionId, binding: {} });
	if (leaseRef.current.id !== sessionId)
		leaseRef.current = { id: sessionId, binding: {} };
	const lease = leaseRef.current;
	const ownsComposer = () => mounted.current && leaseRef.current === lease;
	const [, publishLease] = useState(0);
	const invalidate = useCallback(() => {
		leaseRef.current = { ...leaseRef.current };
		publishLease((n) => n + 1);
	}, []);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const revision = useRef(0);
	const currentDraft = useRef<{ owner: object; text: string } | null>(null);
	const [input, setInput] = useState<{ owner: object; text: string } | null>(
		null,
	);
	const [staged, setStaged] = useState<{
		owner: object;
		files: AttachedFile[];
	} | null>(null);
	const currentFiles = useRef(staged);
	const restore = (text: string) => {
		if (!mounted.current || leaseRef.current.binding !== lease.binding)
			return;
		revision.current++;
		const next = { owner: lease.binding, text };
		currentDraft.current = next;
		setInput(next);
	};
	const companion = useNoteCompanion(sessionId, restore);
	function changeDraft(change: SetStateAction<string>) {
		if (!ownsComposer() || !sessionId) return;
		const old = currentDraft.current;
		const text =
			typeof change === "function"
				? change(old?.owner === lease.binding ? old.text : "")
				: change;
		restore(text);
		companion.setDraft(text);
	}
	function changeFiles(change: SetStateAction<AttachedFile[]>) {
		if (!ownsComposer() || !sessionId) return;
		revision.current++;
		const old = currentFiles.current;
		const next = {
			owner: lease.binding,
			files:
				typeof change === "function"
					? change(old?.owner === lease.binding ? old.files : [])
					: change,
		};
		currentFiles.current = next;
		setStaged(next);
	}
	async function send(operation: () => Promise<boolean>) {
		if (!ownsComposer()) return false;
		const submitted = revision.current;
		const confirmed = await operation();
		if (confirmed && ownsComposer() && revision.current === submitted) {
			changeDraft("");
			changeFiles([]);
		}
		return confirmed;
	}
	return {
		companion,
		// Keep drafts and attachments during a reconnect of the same owner, but
		// never reuse a prior owner's displayed data merely because its ID returns.
		inputValue: input?.owner === lease.binding ? input.text : "",
		attachedFiles:
			staged?.owner === lease.binding ? staged.files : EMPTY_ATTACHMENTS,
		changeDraft,
		changeFiles,
		ownsComposer,
		invalidate,
		send,
	};
}
