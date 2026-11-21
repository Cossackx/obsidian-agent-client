import { readCorrelatedReply } from "../services/passage-review";
/**
 * Sub-hook for managing chat messages, streaming, and permissions.
 *
 * Handles message state, RAF batching for streaming updates,
 * send/receive operations, and permission approve/reject.
 */

import * as React from "react";
const { useState, useCallback, useMemo, useRef, useEffect } = React;

import type {
	ChatMessage,
	MessageContent,
	ActivePermission,
	ImagePromptContent,
	ResourceLinkPromptContent,
} from "../types/chat";
import type { ChatSession, SessionUpdate } from "../types/session";
import type { AcpClient } from "../acp/acp-client";
import type { IVaultAccess, NoteMetadata } from "../services/vault-service";
import type { IWikilinkResolver } from "../utils/wikilink-resolver";
import type { ISettingsAccess } from "../services/settings-service";
import type { ErrorInfo } from "../types/errors";
import type { IMentionService } from "../utils/mention-parser";
import { preparePrompt, sendPreparedPrompt } from "../services/message-sender";
import type { PreparedContext } from "../services/context-builder";
import type { PromptContent } from "../types/chat";
import { extractErrorMessage } from "../utils/error-utils";
import { Platform } from "obsidian";
import {
	rebuildToolCallIndex,
	applySingleUpdate,
	findActivePermission,
	selectOption,
} from "../services/message-state";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for sending a message.
 */
export interface SendMessageOptions {
	preparedContext?: PreparedContext;
	generatedInstruction?: string;
	canDispatch?: () => boolean;
	approvePayload?: (
		blocks: readonly PromptContent[],
		sources: PreparedContext["sources"],
		notices: readonly string[],
	) => Promise<boolean>;
	structuredRequestId?: string;
	/** Transcript generation captured by the caller before its first await. */
	transcriptVersion?: number;
	onDispatch?: () => void;
	onConfirmed?: (
		reply: string,
		userMessageId: string,
		assistantId: string,
		sources: PreparedContext["sources"],
	) => void;
	/** Currently active note for auto-mention */
	activeNote: NoteMetadata | null;
	/** Vault base path for mention resolution */
	vaultBasePath: string;
	/** Whether auto-mention is temporarily disabled */
	isAutoMentionDisabled?: boolean;
	/** Attached images (Base64 embedded) */
	images?: ImagePromptContent[];
	/** Attached file references (resource links) */
	resourceLinks?: ResourceLinkPromptContent[];
	/** Whether this is the first message in the session */
	isFirstMessage?: boolean;
}

export interface TranscriptSnapshot {
	version: number;
	messages: ChatMessage[];
}

export interface UseAgentMessagesReturn {
	// Message state
	messages: ChatMessage[];
	isSending: boolean;
	transcriptVersion: number;
	takeTranscriptSnapshot: () => TranscriptSnapshot;
	beforeTranscriptReplacement: (
		save: (snapshot: TranscriptSnapshot) => void,
	) => () => void;

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
	/** Discard any pending RAF updates and reset streaming state (call after stop/cancel). */
	clearPendingUpdates: () => void;

	// Permission
	activePermission: ActivePermission | null;
	hasActivePermission: boolean;
	approvePermission: (requestId: string, optionId: string) => Promise<void>;
	approveActivePermission: () => Promise<boolean>;
	rejectActivePermission: () => Promise<boolean>;

	/** Enqueue a message-level update (used by useAgent for unified handler) */
	enqueueUpdate: (update: SessionUpdate) => void;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useAgentMessages(
	agentClient: AcpClient,
	settingsAccess: ISettingsAccess,
	vaultAccess: IVaultAccess & IMentionService & IWikilinkResolver,
	session: ChatSession,
	setErrorInfo: (error: ErrorInfo | null) => void,
): UseAgentMessagesReturn {
	// ============================================================
	// Message State
	// ============================================================

	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [isSending, setIsSending] = useState(false);
	const [transcriptVersion, replaceTranscript] = useState(0);
	// React renders are a projection of this transcript, not its source of truth.
	const transcript = useRef<TranscriptSnapshot>({ version: 0, messages });
	const mounted = useRef(true);
	const ownerEpoch = useRef({ id: session.sessionId });
	if (ownerEpoch.current.id !== session.sessionId)
		ownerEpoch.current = { id: session.sessionId };
	const onReplace = useRef<((snapshot: TranscriptSnapshot) => void) | null>(
		null,
	);

	// Tool call index: toolCallId → message index for O(1) lookup
	const toolCallIndexRef = useRef<Map<string, number>>(new Map());

	// Ignore updates flag (used during session/load to skip history replay)
	const ignoreUpdatesRef = useRef(false);

	// Generation counter to prevent stale async callbacks from overwriting
	// state after cancel/stop followed by a new send. Each sendMessage()
	// increments this; completion handlers only update state if the
	// generation hasn't changed (fixes Issue #200).
	const generationRef = useRef(0);

	// Track the current send promise so a new sendMessage() can wait for
	// the previous one to settle before starting (avoids interleaved sends).
	const sendPromiseRef = useRef<Promise<void> | null>(null);
	const preparingRef = useRef(false);
	const replyRef = useRef<{
		sessionId: string;
		text: string;
		live: () => boolean;
		structured: boolean;
	} | null>(null);

	// ============================================================
	// Streaming Update Batching
	// ============================================================

	const pendingUpdatesRef = useRef<SessionUpdate[]>([]);
	const flushScheduledRef = useRef(false);

	const applyUpdates = useCallback((updates: SessionUpdate[]) => {
		for (const update of updates) {
			transcript.current.messages = applySingleUpdate(
				transcript.current.messages,
				update,
				toolCallIndexRef.current,
			);
		}
	}, []);
	const takeTranscriptSnapshot = useCallback((): TranscriptSnapshot => {
		const updates = pendingUpdatesRef.current;
		pendingUpdatesRef.current = [];
		applyUpdates(updates);
		return { ...transcript.current };
	}, [applyUpdates]);
	const flushPendingUpdates = useCallback(() => {
		flushScheduledRef.current = false;
		setMessages(takeTranscriptSnapshot().messages);
	}, [takeTranscriptSnapshot]);
	const beforeTranscriptReplacement = useCallback(
		(save: (snapshot: TranscriptSnapshot) => void) => {
			onReplace.current = save;
			return () => {
				if (onReplace.current === save) onReplace.current = null;
			};
		},
		[],
	);

	const enqueueUpdate = useCallback(
		(update: SessionUpdate) => {
			if (ignoreUpdatesRef.current) return;
			const request = replyRef.current;
			if (request?.sessionId === update.sessionId && !request.live())
				return;
			if (
				update.type === "agent_message_chunk" &&
				request?.structured &&
				request.sessionId === update.sessionId
			) {
				if (request.text.length <= 180_000) request.text += update.text;
				return;
			}
			// Some agents echo the prompt back as a user_message_chunk while
			// the prompt RPC is still open; the transcript already holds it.
			if (
				update.type === "user_message_chunk" &&
				sendPromiseRef.current !== null
			) {
				return;
			}
			pendingUpdatesRef.current.push(update);
			if (!flushScheduledRef.current) {
				flushScheduledRef.current = true;
				window.requestAnimationFrame(flushPendingUpdates);
			}
		},
		[flushPendingUpdates],
	);

	// Clean up on unmount
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			pendingUpdatesRef.current = [];
			flushScheduledRef.current = false;
			toolCallIndexRef.current.clear();
		};
	}, []);

	// ============================================================
	// Message Operations
	// ============================================================

	const addMessage = useCallback(
		(message: ChatMessage): void => {
			const before = takeTranscriptSnapshot();
			const next = [...before.messages, message];
			transcript.current.messages = next;
			setMessages(next);
		},
		[takeTranscriptSnapshot],
	);

	const setIgnoreUpdates = useCallback((ignore: boolean): void => {
		ignoreUpdatesRef.current = ignore;
	}, []);

	/**
	 * Cancel-time cleanup. Discards in-flight streaming updates so they don't
	 * bleed into the next reply (#200), but still applies any queued permission
	 * lifecycle updates (cancel/response) so the permission banner clears
	 * instead of staying stuck (#326).
	 */
	const clearPendingUpdates = useCallback((): void => {
		const queued = pendingUpdatesRef.current;
		pendingUpdatesRef.current = [];
		flushScheduledRef.current = false;

		// Streaming deltas are dropped; only terminal permission updates
		// (cancelled or answered) are applied so `findActivePermission` stops
		// returning the request. Active/pending permission updates are not
		// replayed, so a cancel can never re-surface an active banner.
		const permissionUpdates = queued.filter(
			(u) =>
				(u.type === "tool_call" || u.type === "tool_call_update") &&
				(u.permissionRequest?.isCancelled === true ||
					u.permissionRequest?.selectedOptionId !== undefined),
		);
		if (permissionUpdates.length > 0) {
			applyUpdates(permissionUpdates);
			setMessages(transcript.current.messages);
		}

		setIsSending(false);
	}, [applyUpdates]);

	const setMessagesFromLocal = useCallback(
		(localMessages: ChatMessage[]): void => {
			// Last synchronous boundary before the outgoing queue and index are replaced.
			const outgoing = takeTranscriptSnapshot();
			onReplace.current?.(outgoing);
			const version = outgoing.version + 1;
			transcript.current = { version, messages: localMessages };
			replaceTranscript(version);
			setMessages(localMessages);
			rebuildToolCallIndex(localMessages, toolCallIndexRef.current);
			setIsSending(false);
			setErrorInfo(null);
		},
		[setErrorInfo, takeTranscriptSnapshot],
	);
	const clearMessages = useCallback(
		() => setMessagesFromLocal([]),
		[setMessagesFromLocal],
	);

	const setInitialMessages = useCallback(
		(
			history: Array<{
				role: string;
				content: Array<{ type: string; text: string }>;
				timestamp?: string;
			}>,
		): void => {
			const chatMessages: ChatMessage[] = history.map((msg) => ({
				id: crypto.randomUUID(),
				role: msg.role as "user" | "assistant",
				content: msg.content.map((c) => ({
					type: c.type as "text",
					text: c.text,
				})),
				timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
			}));

			setMessagesFromLocal(chatMessages);
		},
		[setMessagesFromLocal],
	);

	const clearError = useCallback((): void => {
		setErrorInfo(null);
	}, [setErrorInfo]);

	const shouldConvertToWsl = useMemo(() => {
		const settings = settingsAccess.getSnapshot();
		return Platform.isWin && settings.windowsWslMode;
	}, [settingsAccess]);

	const sendMessage = useCallback(
		async (content: string, options: SendMessageOptions): Promise<void> => {
			if (preparingRef.current) return;
			if (
				!session.sessionId ||
				!agentClient.hasLiveSession(session.sessionId)
			) {
				setErrorInfo({
					title: "Cannot Send Message",
					message: "No active session. Please wait for connection.",
				});
				return;
			}

			// Wait for any in-flight send to settle (e.g. after cancel/stop)
			// before starting a new one to avoid interleaved state updates.
			const currentSessionId = session.sessionId;
			const owner = ownerEpoch.current;
			const version =
				options.transcriptVersion ?? transcript.current.version;
			const ownsTranscript = () =>
				mounted.current &&
				ownerEpoch.current === owner &&
				owner.id === currentSessionId &&
				transcript.current.version === version &&
				options.canDispatch?.() !== false;
			if (sendPromiseRef.current) {
				try {
					await sendPromiseRef.current;
				} catch {
					/* ignore */
				}
			}

			if (!ownsTranscript()) return;
			const generation = ++generationRef.current;
			const settings = settingsAccess.getSnapshot();

			preparingRef.current = true;
			try {
				const prepared = await preparePrompt(
					{
						message: content,
						generatedInstruction: options.generatedInstruction,
						preparedContext: options.preparedContext,
						images: options.images,
						resourceLinks: options.resourceLinks,
						activeNote: options.activeNote,
						vaultBasePath: options.vaultBasePath,
						isAutoMentionDisabled: options.isAutoMentionDisabled,
						convertToWsl: shouldConvertToWsl,
						supportsEmbeddedContext:
							session.promptCapabilities?.embeddedContext ??
							false,
						maxNoteLength: settings.displaySettings.maxNoteLength,
						maxSelectionLength:
							settings.displaySettings.maxSelectionLength,
						isFirstMessage: options.isFirstMessage,
						promptInjection: settings.promptInjection.enabled
							? {
									latex: settings.promptInjection.latex,
									wikiLinks:
										settings.promptInjection.wikiLinks,
									tables: settings.promptInjection.tables,
								}
							: undefined,
						expandWikilinkContext: settings.expandWikilinkContext,
						wikilinkResolver: vaultAccess,
					},
					vaultAccess,
					vaultAccess, // IMentionService (same object)
				);
				if (
					options.approvePayload &&
					!(await options.approvePayload(
						prepared.agentContent,
						prepared.sources,
						prepared.notices ?? [],
					))
				)
					return;
				if (
					!agentClient.hasLiveSession(currentSessionId) ||
					generation !== generationRef.current ||
					!ownsTranscript()
				)
					return;

				const userMessageContent: MessageContent[] = [];

				if (prepared.autoMentionContext) {
					userMessageContent.push({
						type: "text_with_context",
						text: content,
						autoMentionContext: prepared.autoMentionContext,
					});
				} else {
					userMessageContent.push({
						type: "text",
						text: content,
					});
				}

				if (options.images && options.images.length > 0) {
					for (const img of options.images) {
						userMessageContent.push({
							type: "image",
							data: img.data,
							mimeType: img.mimeType,
						});
					}
				}

				if (options.resourceLinks && options.resourceLinks.length > 0) {
					for (const link of options.resourceLinks) {
						userMessageContent.push({
							type: "resource_link",
							uri: link.uri,
							name: link.name,
							mimeType: link.mimeType,
							size: link.size,
						});
					}
				}

				const userMessage: ChatMessage = {
					id: crypto.randomUUID(),
					role: "user",
					content: userMessageContent,
					timestamp: new Date(),
				};
				addMessage(userMessage);

				setIsSending(true);

				const sendPromise = (async () => {
					const live = () =>
						generationRef.current === generation &&
						ownsTranscript();
					const reply = {
						sessionId: currentSessionId,
						text: "",
						live,
						structured: !!options.structuredRequestId,
					};
					replyRef.current = reply;
					try {
						options.onDispatch?.();
						const result = await sendPreparedPrompt(
							{
								sessionId: currentSessionId,
								agentContent: prepared.agentContent,
								displayContent: prepared.displayContent,
								authMethods: options.approvePayload
									? []
									: session.authMethods,
								strictCompletion: !!options.approvePayload,
							},
							agentClient,
						);

						// A confirmed RPC still belongs to the original turn. It must
						// not publish an assistant reply into a replaced transcript.
						if (!live()) {
							if (result.success)
								options.onConfirmed?.(
									"",
									userMessage.id,
									"",
									prepared.sources,
								);
							return;
						}

						if (result.success) {
							setIsSending(false);
							let responseText = reply.text;
							let correlated = false;
							if (options.structuredRequestId) {
								try {
									const value = readCorrelatedReply(
										reply.text,
										options.structuredRequestId,
									);
									if (typeof value === "string")
										responseText = value;
									correlated = true;
								} catch {
									/* Unattributed discussion, never actionable. */
								}
							}
							const assistantId = reply.text
								? crypto.randomUUID()
								: "";
							if (assistantId)
								addMessage({
									id: assistantId,
									role: "assistant",
									content: [
										{ type: "text", text: responseText },
									],
									timestamp: new Date(),
								});
							try {
								options.onConfirmed?.(
									reply.text,
									userMessage.id,
									correlated ? assistantId : "",
									prepared.sources,
								);
							} catch {
								setErrorInfo({
									title: "Turn sent",
									message:
										"The local response action could not be completed. Do not resend the turn.",
								});
							}
						} else {
							setIsSending(false);
							setErrorInfo(
								result.error
									? {
											title: result.error.title,
											message: result.error.message,
											suggestion: result.error.suggestion,
										}
									: {
											title: "Send Message Failed",
											message: "Failed to send message",
										},
							);
						}
					} catch (error) {
						if (!live()) return;
						setIsSending(false);
						setErrorInfo({
							title: "Send Message Failed",
							message: `Failed to send message: ${extractErrorMessage(error)}`,
						});
					} finally {
						if (replyRef.current === reply) replyRef.current = null;
					}
				})();

				sendPromiseRef.current = sendPromise;
				try {
					await sendPromise;
				} catch {
					// Error already handled inside sendPromise
				} finally {
					sendPromiseRef.current = null;
				}
			} finally {
				preparingRef.current = false;
			}
		},
		[
			agentClient,
			vaultAccess,
			settingsAccess,
			session.sessionId,
			session.authMethods,
			session.promptCapabilities,
			shouldConvertToWsl,
			addMessage,
			setErrorInfo,
		],
	);

	// ============================================================
	// Permission State & Operations
	// ============================================================

	const activePermission = useMemo(
		() => findActivePermission(messages),
		[messages],
	);

	const hasActivePermission = activePermission !== null;

	const approvePermission = useCallback(
		async (requestId: string, optionId: string | null): Promise<void> => {
			try {
				await agentClient.respondToPermission(requestId, optionId);
			} catch (error) {
				setErrorInfo({
					title: "Permission Error",
					message: `Failed to respond to permission request: ${extractErrorMessage(error)}`,
				});
			}
		},
		[agentClient, setErrorInfo],
	);

	const approveActivePermission = useCallback(async (): Promise<boolean> => {
		if (!activePermission || activePermission.options.length === 0)
			return false;
		const option = selectOption(activePermission.options, [
			"allow_once",
			"allow_always",
		]);
		if (!option) return false;
		await approvePermission(activePermission.requestId, option.optionId);
		return true;
	}, [activePermission, approvePermission]);

	const rejectActivePermission = useCallback(async (): Promise<boolean> => {
		if (!activePermission || activePermission.options.length === 0)
			return false;
		const option = selectOption(activePermission.options, [
			"reject_once",
			"reject_always",
		]);
		await approvePermission(
			activePermission.requestId,
			option?.optionId ?? null,
		);
		return true;
	}, [activePermission, approvePermission]);

	// ============================================================
	// Return
	// ============================================================

	return {
		messages,
		isSending,
		transcriptVersion,
		takeTranscriptSnapshot,
		beforeTranscriptReplacement,
		sendMessage,
		clearMessages,
		setInitialMessages,
		setMessagesFromLocal,
		clearError,
		setIgnoreUpdates,
		clearPendingUpdates,
		activePermission,
		hasActivePermission,
		approvePermission,
		approveActivePermission,
		rejectActivePermission,
		enqueueUpdate,
	};
}
