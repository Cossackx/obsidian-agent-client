import * as acp from "@agentclientprotocol/sdk";

import type { SessionUpdate } from "../types/session";
import { AcpTypeConverter } from "./type-converter";
import type { PermissionManager } from "./permission-handler";
import type { TerminalManager } from "./terminal-handler";
import type { Logger } from "../utils/logger";

/**
 * Handles incoming ACP protocol events from the agent.
 *
 * These methods are registered by ACP method name on the client app
 * (acp.client(...)) in AcpClient, and receive session updates, permission
 * requests, and terminal operations dispatched by the SDK connection.
 *
 * This class does not initiate communication — that is AcpClient's role.
 * It only reacts to events from the agent side.
 */
export class AcpHandler {
	private sessionUpdateListeners = new Set<(update: SessionUpdate) => void>();
	private restoreCapture: {
		sessionId: string;
		updates: SessionUpdate[];
	} | null = null;

	/** Tracks session updates during a prompt. */
	private promptSessionUpdateCount = 0;

	constructor(
		private permissionManager: PermissionManager,
		private terminalManager: TerminalManager,
		private getWorkingDirectory: () => string,
		private getCurrentSessionId: () => string | null,
		private logger: Logger,
	) {}

	// ====================================================================
	// Callback Registration
	// ====================================================================

	/** Reset the update counter. Called by AcpClient before each sendPrompt. */
	resetUpdateCount(): void {
		this.promptSessionUpdateCount = 0;
	}

	/** Whether any session update was received since the last reset. */
	hasReceivedUpdates(): boolean {
		return this.promptSessionUpdateCount > 0;
	}

	onSessionUpdate(callback: (update: SessionUpdate) => void): () => void {
		this.sessionUpdateListeners.add(callback);
		return () => this.sessionUpdateListeners.delete(callback);
	}

	/** Collect provisional replay without delivering it to the current view. */
	captureRestore(sessionId: string) {
		const capture = { sessionId, updates: [] as SessionUpdate[] };
		this.restoreCapture = capture;
		return {
			updates: capture.updates,
			stop: () => {
				if (this.restoreCapture === capture) this.restoreCapture = null;
			},
		};
	}

	/** Emit a session update to all listeners. Filters by current sessionId. */
	emitSessionUpdate(update: SessionUpdate): void {
		if (this.restoreCapture && update.type !== "process_error") {
			if (update.sessionId === this.restoreCapture.sessionId)
				this.restoreCapture.updates.push(update);
			return;
		}
		const currentId = this.getCurrentSessionId();
		if (currentId && update.sessionId !== currentId) {
			return;
		}
		for (const listener of this.sessionUpdateListeners) {
			listener(update);
		}
	}

	// ====================================================================
	// ACP Client Protocol Handlers (registered on the client app)
	// ====================================================================

	sessionUpdate(params: acp.SessionNotification): Promise<void> {
		const update = params.update;
		const sessionId = params.sessionId;
		this.promptSessionUpdateCount++;
		this.logger.log("[AcpHandler] sessionUpdate:", {
			sessionId,
			type: update.sessionUpdate,
		});

		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk":
				if (update.content.type === "text") {
					this.emitSessionUpdate({
						type: update.sessionUpdate,
						sessionId,
						text: update.content.text,
					});
				}
				break;
			case "user_message_chunk":
				// ACP replays wire prompts, not the local display transcript.
				// Keep the turn boundary, not the untrusted payload.
				this.emitSessionUpdate({
					type: "user_message_chunk",
					sessionId,
				});
				break;

			case "tool_call":
				this.emitSessionUpdate({
					type: "tool_call",
					sessionId,
					toolCallId: update.toolCallId,
					title: update.title,
					status: update.status || "pending",
					kind: update.kind ?? undefined,
					content: AcpTypeConverter.toToolCallContent(update.content),
					locations: update.locations ?? [],
					rawInput: update.rawInput as
						| { [k: string]: unknown }
						| undefined,
					rawOutput: update.rawOutput,
				});
				break;

			case "tool_call_update":
				this.emitSessionUpdate({
					type: "tool_call_update",
					sessionId,
					toolCallId: update.toolCallId,
					title: update.title,
					status: update.status ?? undefined,
					kind: update.kind ?? undefined,
					content: AcpTypeConverter.toToolCallContent(update.content),
					locations:
						update.locations === undefined
							? undefined
							: (update.locations ?? []),
					rawInput: update.rawInput as
						| { [k: string]: unknown }
						| undefined,
					rawOutput: update.rawOutput,
				});
				break;

			case "plan":
				this.emitSessionUpdate({
					type: "plan",
					sessionId,
					entries: update.entries,
				});
				break;

			case "available_commands_update":
				this.emitSessionUpdate({
					type: "available_commands_update",
					sessionId,
					commands: AcpTypeConverter.toSlashCommands(
						update.availableCommands,
					),
				});
				break;

			case "current_mode_update":
				this.emitSessionUpdate({
					type: "current_mode_update",
					sessionId,
					currentModeId: update.currentModeId,
				});
				break;

			case "session_info_update":
				this.emitSessionUpdate({
					type: "session_info_update",
					sessionId,
					title: update.title,
					updatedAt: update.updatedAt,
				});
				break;

			case "usage_update":
				this.emitSessionUpdate({
					type: "usage_update",
					sessionId,
					size: update.size,
					used: update.used,
					cost: update.cost ?? undefined,
				});
				break;

			case "config_option_update":
				this.emitSessionUpdate({
					type: "config_option_update",
					sessionId,
					configOptions: AcpTypeConverter.toSessionConfigOptions(
						update.configOptions,
					),
				});
				break;
		}
		return Promise.resolve();
	}

	requestPermission(
		params: acp.RequestPermissionRequest,
	): Promise<acp.RequestPermissionResponse> {
		// Replay is not a user-authorized prompt or permission surface.
		if (this.restoreCapture)
			return Promise.resolve({ outcome: { outcome: "cancelled" } });
		return this.permissionManager.request(params);
	}

	// ====================================================================
	// Disabled File System Methods
	// ====================================================================

	readTextFile(_params: acp.ReadTextFileRequest): never {
		throw acp.RequestError.methodNotFound("fs/read_text_file");
	}

	writeTextFile(_params: acp.WriteTextFileRequest) {
		throw acp.RequestError.methodNotFound("fs/write_text_file");
	}

	// ====================================================================
	// Terminal Operations (registered on the client app)
	// ====================================================================

	createTerminal(
		params: acp.CreateTerminalRequest,
	): Promise<acp.CreateTerminalResponse> {
		this.logger.log(
			"[AcpHandler] createTerminal called with params:",
			params,
		);

		const terminalId = this.terminalManager.createTerminal({
			command: params.command,
			args: params.args,
			cwd: params.cwd || this.getWorkingDirectory(),
			env: params.env ?? undefined,
			outputByteLimit: params.outputByteLimit ?? undefined,
		});
		return Promise.resolve({ terminalId });
	}

	terminalOutput(
		params: acp.TerminalOutputRequest,
	): Promise<acp.TerminalOutputResponse> {
		const result = this.terminalManager.getOutput(params.terminalId);
		if (!result) {
			throw new Error(`Terminal ${params.terminalId} not found`);
		}
		return Promise.resolve(result);
	}

	async waitForTerminalExit(
		params: acp.WaitForTerminalExitRequest,
	): Promise<acp.WaitForTerminalExitResponse> {
		return await this.terminalManager.waitForExit(params.terminalId);
	}

	killTerminal(
		params: acp.KillTerminalRequest,
	): Promise<acp.KillTerminalResponse> {
		const success = this.terminalManager.killTerminal(params.terminalId);
		if (!success) {
			throw new Error(`Terminal ${params.terminalId} not found`);
		}
		return Promise.resolve({});
	}

	releaseTerminal(
		params: acp.ReleaseTerminalRequest,
	): Promise<acp.ReleaseTerminalResponse> {
		const success = this.terminalManager.releaseTerminal(params.terminalId);
		if (!success) {
			this.logger.log(
				`[AcpHandler] releaseTerminal: Terminal ${params.terminalId} not found (may have been already cleaned up)`,
			);
		}
		return Promise.resolve({});
	}
}
