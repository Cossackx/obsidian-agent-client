import * as React from "react";
const { useCallback, useEffect, useRef, useState, useSyncExternalStore } =
	React;

import type AgentClientPlugin from "../plugin";
import type { ChatMessage } from "../types/chat";
import {
	AudioPlayer,
	MicCapture,
	blobToAudioPayload,
} from "../services/mic-capture";
import {
	DictationController,
	VoiceChatController,
	insertAtCursor,
	type DictationState,
	type VoiceChatState,
} from "../services/voice-chat";
import type { SpokenAudio } from "../services/voice-helper";

/** Recordings smaller than this hold no usable speech (container header only). */
const MIN_AUDIO_BYTES = 1000;

interface UseVoiceOptions {
	plugin: AgentClientPlugin;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	inputValue: string;
	onInputChange: (value: string) => void;
	/** Normal send path; resolves when the agent's turn is complete. */
	onSendMessage: (content: string) => Promise<void>;
	onStopGeneration: () => Promise<void>;
	messages: ChatMessage[];
}

/** Spoken-eligible reply text: assistant text blocks only (no tools, no thoughts). */
function replyText(messages: ChatMessage[], from: number): string {
	return messages
		.slice(from)
		.filter((m) => m.role === "assistant")
		.map((m) =>
			m.content
				.map((c) => (c.type === "text" ? c.text : ""))
				.filter(Boolean)
				.join("\n"),
		)
		.filter(Boolean)
		.join("\n");
}

export function useVoice({
	plugin,
	textareaRef,
	inputValue,
	onInputChange,
	onSendMessage,
	onStopGeneration,
	messages,
}: UseVoiceOptions) {
	const helper = plugin.voiceHelper;
	const status = useSyncExternalStore(helper.subscribe, helper.getStatus);
	const enabled = plugin.settings.voice.enabled;

	const [dictationState, setDictationState] =
		useState<DictationState>("idle");
	const [voiceChatState, setVoiceChatState] = useState<VoiceChatState>("off");
	const [voiceError, setVoiceError] = useState<string | null>(null);

	// Latest values for long-lived controller callbacks.
	const latest = useRef({
		inputValue,
		onInputChange,
		onSendMessage,
		onStopGeneration,
		messages,
	});
	latest.current = {
		inputValue,
		onInputChange,
		onSendMessage,
		onStopGeneration,
		messages,
	};
	const replyBaseRef = useRef(0);

	const micRef = useRef<MicCapture | null>(null);
	const playerRef = useRef<AudioPlayer | null>(null);
	const mic = (micRef.current ??= new MicCapture());
	const player = (playerRef.current ??= new AudioPlayer());

	const transcribeRecording = useCallback(async (): Promise<string> => {
		const blob = await mic.stopRecording();
		if (!blob || blob.size < MIN_AUDIO_BYTES) return "";
		const { base64, ext } = await blobToAudioPayload(blob);
		return helper.transcribe(base64, ext);
	}, [mic, helper]);

	const dictationRef = useRef<DictationController | null>(null);
	dictationRef.current ??= new DictationController({
		startRecording: async () => {
			await mic.open();
			mic.startRecording();
		},
		finishRecording: async () => {
			try {
				return await transcribeRecording();
			} finally {
				mic.close();
			}
		},
		cancelRecording: () => mic.close(),
		insert: (text) => {
			const el = textareaRef.current;
			const value = latest.current.inputValue;
			const start = el?.selectionStart ?? value.length;
			const end = el?.selectionEnd ?? value.length;
			const next = insertAtCursor(value, start, end, text);
			latest.current.onInputChange(next.value);
			window.requestAnimationFrame(() => {
				el?.focus();
				el?.setSelectionRange(next.cursor, next.cursor);
			});
		},
		onState: setDictationState,
		onError: setVoiceError,
	});

	const voiceChatRef = useRef<VoiceChatController<SpokenAudio> | null>(null);
	voiceChatRef.current ??= new VoiceChatController<SpokenAudio>(
		{
			startRecording: () => mic.startRecording(),
			finishRecording: transcribeRecording,
			cancelRecording: () => mic.cancelRecording(),
			send: async (text) => {
				replyBaseRef.current = latest.current.messages.length;
				await latest.current.onSendMessage(text);
				// shortcut: streamed chunks are flushed per animation frame; wait
				// one frame + a tick so the last sentence is in `messages`.
				await new Promise((r) => window.requestAnimationFrame(r));
				await new Promise((r) => window.setTimeout(r, 50));
			},
			getReplyText: () =>
				replyText(latest.current.messages, replyBaseRef.current),
			cancelReply: () => void latest.current.onStopGeneration(),
			synthesize: (text) => helper.speak(text),
			play: (audio) => player.play(audio),
			stopPlayback: () => player.stop(),
			onState: (state) => {
				setVoiceChatState(state);
				if (state === "off") mic.close();
			},
			onError: setVoiceError,
		},
		() => plugin.settings.voice,
	);

	// Start the shared helper when voice is enabled.
	useEffect(() => {
		if (enabled && helper.getStatus().state === "off") helper.start();
	}, [enabled, helper]);

	// Turning voice off in settings ends any session in progress.
	useEffect(() => {
		if (enabled) return;
		voiceChatRef.current?.stop();
		dictationRef.current?.cancel();
	}, [enabled]);

	// Streamed reply text -> speak sentences as they complete.
	useEffect(() => {
		voiceChatRef.current?.onReplyText();
	}, [messages]);

	const toggleDictation = useCallback(() => {
		setVoiceError(null);
		void dictationRef.current?.toggle();
	}, []);

	const toggleVoiceChat = useCallback(() => {
		const vc = voiceChatRef.current;
		if (!vc) return;
		setVoiceError(null);
		if (vc.getState() !== "off") {
			vc.stop();
			return;
		}
		dictationRef.current?.cancel();
		mic.open((rms) => vc.onLevel(rms, performance.now())).then(
			() => vc.start(),
			() => {
				mic.close();
				setVoiceError("Couldn't use the microphone.");
			},
		);
	}, [mic]);

	/** Escape: interrupt speech, else end voice chat; or finish dictation. */
	const active = dictationState === "recording" || voiceChatState !== "off";
	useEffect(() => {
		if (!active) return;
		const doc = textareaRef.current?.ownerDocument ?? document;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			if (voiceChatRef.current?.getState() !== "off") {
				voiceChatRef.current?.stop();
			} else {
				void dictationRef.current?.toggle();
			}
		};
		doc.addEventListener("keydown", onKey, true);
		return () => doc.removeEventListener("keydown", onKey, true);
	}, [active, textareaRef]);

	// Release mic and audio when the view goes away.
	useEffect(
		() => () => {
			voiceChatRef.current?.stop();
			dictationRef.current?.cancel();
			mic.close();
			player.stop();
		},
		[mic, player],
	);

	return {
		enabled,
		status,
		dictationState,
		voiceChatState,
		voiceError,
		clearVoiceError: () => setVoiceError(null),
		toggleDictation,
		toggleVoiceChat,
		interruptSpeech: () => voiceChatRef.current?.interrupt(),
		retry: () => helper.start(),
	};
}

export type VoiceApi = ReturnType<typeof useVoice>;
