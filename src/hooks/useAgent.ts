/**
 * Hook for managing the complete agent interaction lifecycle.
 *
 * This is a facade that composes useAgentSession and useAgentMessages,
 * providing a unified API to ChatPanel.
 */

import * as React from "react";
const { useState, useCallback, useEffect, useMemo } = React;

import type { SessionUpdate } from "../types/session";
import type { AcpClient } from "../acp/acp-client";
import type { IVaultAccess } from "../services/vault-service";
import type { ISettingsAccess } from "../services/settings-service";
import type { ErrorInfo } from "../types/errors";
import type { IMentionService } from "../utils/mention-parser";
import type { IWikilinkResolver } from "../utils/wikilink-resolver";
import { useAgentSession } from "./useAgentSession";
import {
	useAgentMessages,
	type SendMessageOptions,
	type TranscriptSnapshot,
} from "./useAgentMessages";

// Re-export types that ChatPanel uses
export type { SendMessageOptions } from "./useAgentMessages";
export type { AgentDisplayInfo } from "../services/session-helpers";

// ============================================================================
// Types
// ============================================================================

import type { ChatMessage, ActivePermission } from "../types/chat";
import type {
	ChatSession,
	SessionModeState,
	SessionConfigOption,
} from "../types/session";
import type { AgentDisplayInfo } from "../services/session-helpers";

/**
 * Return type for useAgent hook.
 */
export interface UseAgentReturn {
	// Session state
	session: ChatSession;
	isReady: boolean;

	// Message state
	messages: ChatMessage[];
	isSending: boolean;
	transcriptVersion: number;
	takeTranscriptSnapshot: () => TranscriptSnapshot;
	getCurrentTranscript: (sessionId: string) => ChatMessage[] | null;
	beforeTranscriptReplacement: (
		save: (snapshot: TranscriptSnapshot) => void,
	) => () => void;

	// Combined error
	errorInfo: ErrorInfo | null;

	// Session lifecycle
	createSession: (
		overrideAgentId?: string,
		overrideCwd?: string,
	) => Promise<void>;
	restartSession: (
		newAgentId?: string,
		overrideCwd?: string,
	) => Promise<void>;
	closeSession: () => Promise<void>;
	forceRestartAgent: (restoreId?: string, cwd?: string) => Promise<void>;
	cancelOperation: () => Promise<void>;
	getAvailableAgents: () => AgentDisplayInfo[];
	updateSessionFromLoad: (
		sessionId: string,
		modes?: SessionModeState,
		configOptions?: SessionConfigOption[],
	) => Promise<void>;

	// Config
	setMode: (modeId: string) => Promise<void>;
	setConfigOption: (configId: string, value: string) => Promise<void>;

	// Message operations
	sendMessage: (
		content: string,
		options: SendMessageOptions,
	) => Promise<void>;
	clearMessages: () => void;
	setInitialMessages: (
		history: Array<{
			role: string;
			content: Array<{ type: string; text: string }>;
			timestamp?: string;
		}>,
	) => void;
	setMessagesFromLocal: (localMessages: ChatMessage[]) => void;
	clearError: () => void;
	setIgnoreUpdates: (ignore: boolean) => void;
	// Permission
	activePermission: ActivePermission | null;
	hasActivePermission: boolean;
	approvePermission: (requestId: string, optionId: string) => Promise<void>;
	approveActivePermission: () => Promise<boolean>;
	rejectActivePermission: () => Promise<boolean>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * @param agentClient - Agent client for communication
 * @param settingsAccess - Settings access for agent configuration
 * @param vaultAccess - Vault access for reading notes (also serves as IMentionService)
 * @param workingDirectory - Working directory for the session
 * @param initialAgentId - Optional initial agent ID (from view persistence)
 */
export function useAgent(
	agentClient: AcpClient,
	settingsAccess: ISettingsAccess,
	vaultAccess: IVaultAccess & IMentionService & IWikilinkResolver,
	workingDirectory: string,
	initialAgentId?: string,
): UseAgentReturn {
	// ============================================================
	// Shared Error State
	// ============================================================

	const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);

	// ============================================================
	// Sub-hooks
	// ============================================================

	const agentSession = useAgentSession(
		agentClient,
		settingsAccess,
		workingDirectory,
		setErrorInfo,
		initialAgentId,
	);

	const agentMessages = useAgentMessages(
		agentClient,
		settingsAccess,
		vaultAccess,
		agentSession.session,
		setErrorInfo,
	);
	const { getUpdateOwner } = agentSession;
	const { takeTranscriptSnapshot } = agentMessages;
	const getCurrentTranscript = useCallback(
		(sessionId: string) => {
			if (getUpdateOwner() !== sessionId) return null;
			const { messages } = takeTranscriptSnapshot();
			return messages.length > 0 ? messages : null;
		},
		[getUpdateOwner, takeTranscriptSnapshot],
	);

	// ============================================================
	// Unified Session Update Handler
	// ============================================================

	const handleSessionUpdate = useCallback(
		(update: SessionUpdate) => {
			const owner = agentSession.getUpdateOwner();
			if (
				owner &&
				update.type !== "process_error" &&
				update.sessionId !== owner
			)
				return;
			// Session-level updates (commands, mode, config, usage, error)
			agentSession.handleSessionUpdate(update);

			// Message-level updates (batched via RAF, ignoreUpdates checked internally)
			agentMessages.enqueueUpdate(update);
		},
		[
			agentSession.getUpdateOwner,
			agentSession.handleSessionUpdate,
			agentMessages.enqueueUpdate,
		],
	);

	// Composed cancel: session-level cancel + message-level RAF cleanup
	const cancelOperation = useCallback(async () => {
		await agentSession.cancelOperation();
		agentMessages.clearPendingUpdates();
	}, [agentSession.cancelOperation, agentMessages.clearPendingUpdates]);

	// Subscribe to all updates from agent
	useEffect(() => {
		const unsubscribe = agentClient.onSessionUpdate(handleSessionUpdate);
		return unsubscribe;
	}, [agentClient, handleSessionUpdate]);

	// ============================================================
	// Return
	// ============================================================

	return useMemo(
		() => ({
			// Session state
			session: agentSession.session,
			isReady: agentSession.isReady,

			// Message state
			messages: agentMessages.messages,
			isSending: agentMessages.isSending,
			transcriptVersion: agentMessages.transcriptVersion,
			takeTranscriptSnapshot: agentMessages.takeTranscriptSnapshot,
			getCurrentTranscript,
			beforeTranscriptReplacement:
				agentMessages.beforeTranscriptReplacement,

			// Combined error
			errorInfo,

			// Session lifecycle
			createSession: agentSession.createSession,
			restartSession: agentSession.restartSession,
			closeSession: agentSession.closeSession,
			forceRestartAgent: agentSession.forceRestartAgent,
			cancelOperation,
			getAvailableAgents: agentSession.getAvailableAgents,
			updateSessionFromLoad: agentSession.updateSessionFromLoad,

			// Config
			setMode: agentSession.setMode,
			setConfigOption: agentSession.setConfigOption,

			// Message operations
			sendMessage: agentMessages.sendMessage,
			clearMessages: agentMessages.clearMessages,
			setInitialMessages: agentMessages.setInitialMessages,
			setMessagesFromLocal: agentMessages.setMessagesFromLocal,
			clearError: agentMessages.clearError,
			setIgnoreUpdates: agentMessages.setIgnoreUpdates,

			// Permission
			activePermission: agentMessages.activePermission,
			hasActivePermission: agentMessages.hasActivePermission,
			approvePermission: agentMessages.approvePermission,
			approveActivePermission: agentMessages.approveActivePermission,
			rejectActivePermission: agentMessages.rejectActivePermission,
		}),
		[
			agentSession.session,
			agentSession.isReady,
			agentMessages.messages,
			agentMessages.isSending,
			agentMessages.transcriptVersion,
			agentMessages.takeTranscriptSnapshot,
			getCurrentTranscript,
			agentMessages.beforeTranscriptReplacement,
			errorInfo,
			agentSession.createSession,
			agentSession.restartSession,
			agentSession.closeSession,
			agentSession.forceRestartAgent,
			cancelOperation,
			agentSession.getAvailableAgents,
			agentSession.updateSessionFromLoad,
			agentSession.setMode,
			agentSession.setConfigOption,
			agentMessages.sendMessage,
			agentMessages.clearMessages,
			agentMessages.setInitialMessages,
			agentMessages.setMessagesFromLocal,
			agentMessages.clearError,
			agentMessages.setIgnoreUpdates,
			agentMessages.activePermission,
			agentMessages.hasActivePermission,
			agentMessages.approvePermission,
			agentMessages.approveActivePermission,
			agentMessages.rejectActivePermission,
		],
	);
}
