import { useEffect, useRef } from "react";
import { Notice } from "obsidian";
import type { UseAgentReturn } from "./useAgent";
import type { UseSessionHistoryReturn } from "./useSessionHistory";
import type { SettingsService } from "../services/settings-service";

/** A persistent embed uses the same reserved restore boundary as the history picker. */
export function usePersistentEmbedRestore(
	embedId: string | undefined,
	liveSessionId: string | null,
	agentId: string | null,
	settings: Pick<SettingsService, "getSavedSessionByEmbedId">,
	history: Pick<UseSessionHistoryReturn, "canRestore" | "restoreSession">,
	restart: UseAgentReturn["restartSession"],
	setCwd: (cwd: string) => void,
) {
	const attempted = useRef(false);
	const { canRestore, restoreSession } = history;
	useEffect(() => {
		if (!embedId || !liveSessionId || !agentId || attempted.current) return;
		attempted.current = true;
		const saved = settings.getSavedSessionByEmbedId(embedId);
		if (!saved || saved.sessionId === liveSessionId) return;
		const switchingAdapter = saved.agentId !== agentId;
		if (!switchingAdapter && !canRestore) return;
		void restoreSession(
			saved.sessionId,
			saved.cwd,
			async (stillMounted) => {
				if (switchingAdapter) await restart(saved.agentId, saved.cwd);
				if (stillMounted()) setCwd(saved.cwd);
			},
		).catch((error: unknown) => {
			new Notice(
				error instanceof Error
					? error.message
					: "Could not restore this embedded conversation.",
			);
		});
	}, [
		embedId,
		liveSessionId,
		agentId,
		settings,
		canRestore,
		restoreSession,
		restart,
		setCwd,
	]);
}
