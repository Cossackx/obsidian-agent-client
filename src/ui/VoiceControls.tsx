import * as React from "react";

import { LucideIcon } from "./shared/IconButton";
import type { DictationState, VoiceChatState } from "../services/voice-chat";
import type { VoiceHelperStatus } from "../services/voice-helper";

export interface VoiceControlsProps {
	enabled: boolean;
	status: VoiceHelperStatus;
	dictationState: DictationState;
	voiceChatState: VoiceChatState;
	voiceError: string | null;
	clearVoiceError: () => void;
	toggleDictation: () => void;
	toggleVoiceChat: () => void;
	interruptSpeech: () => void;
	retry: () => void;
	/** Voice chat sends messages; block it while the session can't accept one. */
	canSend: boolean;
}

const CHAT_LABEL: Record<Exclude<VoiceChatState, "off">, string> = {
	listening: "Listening…",
	thinking: "Thinking…",
	speaking: "Speaking · tap to interrupt",
};

/** Dictate + voice-chat buttons. Shown only when the Hermes voice helper is healthy. */
export function VoiceControls(props: VoiceControlsProps) {
	const { enabled, status, dictationState, voiceChatState, voiceError } =
		props;
	if (!enabled) return null;

	if (status.state === "unavailable") {
		return (
			<button
				className="agent-client-voice-button agent-client-voice-unavailable"
				aria-label={`Voice unavailable: ${status.reason} Click to retry.`}
				onClick={props.retry}
			>
				<LucideIcon name="mic-off" />
			</button>
		);
	}
	if (status.state !== "ready") return null;

	const dictating = dictationState !== "idle";
	const chatting = voiceChatState !== "off";

	let statusText: string | null = null;
	if (voiceError) statusText = voiceError;
	else if (dictationState === "recording") statusText = "Recording…";
	else if (dictationState === "transcribing") statusText = "Transcribing…";
	else if (chatting) statusText = CHAT_LABEL[voiceChatState];

	const onStatusClick = voiceError
		? props.clearVoiceError
		: voiceChatState === "speaking"
			? props.interruptSpeech
			: undefined;

	return (
		<>
			{statusText && (
				<span
					className={`agent-client-voice-status${voiceError ? " agent-client-voice-error" : ""}${onStatusClick ? " agent-client-voice-status-clickable" : ""}`}
					role="status"
					onClick={onStatusClick}
				>
					{statusText}
				</span>
			)}
			{!chatting && (
				<button
					className={`agent-client-voice-button${dictationState === "recording" ? " agent-client-voice-recording" : ""}`}
					aria-label={
						dictationState === "recording"
							? "Stop dictation (Esc)"
							: "Dictate"
					}
					aria-pressed={dictating}
					disabled={dictationState === "transcribing"}
					onClick={props.toggleDictation}
				>
					<LucideIcon
						name={
							dictationState === "transcribing" ? "loader" : "mic"
						}
					/>
				</button>
			)}
			{!dictating && (
				<button
					className={`agent-client-voice-button${chatting ? " agent-client-voice-active" : ""}`}
					aria-label={
						chatting ? "End voice chat (Esc)" : "Voice chat"
					}
					aria-pressed={chatting}
					disabled={!chatting && !props.canSend}
					onClick={props.toggleVoiceChat}
				>
					<LucideIcon name={chatting ? "phone-off" : "audio-lines"} />
				</button>
			)}
		</>
	);
}
