/**
 * Voice-chat turn-taking and dictation logic, free of browser and React
 * APIs so it can be tested with fakes. Media capture, playback and the
 * Hermes helper are injected.
 */

import { extractSpeakable } from "./speech-text";

export type VoiceChatState = "off" | "listening" | "thinking" | "speaking";

export interface VoiceChatConfig {
	/** Mic RMS level at or above which the user counts as speaking */
	silenceThreshold: number;
	/** Pause (ms) after speech that ends the turn */
	silenceMs: number;
	/** Speaking over a spoken reply interrupts it */
	bargeIn: boolean;
}

export interface VoiceChatDeps<Audio> {
	startRecording(): void;
	/** Stop recording and transcribe; "" means silence. */
	finishRecording(): Promise<string>;
	cancelRecording(): void;
	/** Send through the normal chat send path; resolves when the reply is complete. */
	send(text: string): Promise<void>;
	/** Spoken-eligible text of the reply to the current turn so far. */
	getReplyText(): string;
	cancelReply(): void;
	synthesize(text: string): Promise<Audio>;
	/** Resolves when playback ends or stopPlayback() is called. */
	play(audio: Audio): Promise<void>;
	stopPlayback(): void;
	onState(state: VoiceChatState): void;
	onError(message: string): void;
}

/** Sustained loudness (ms) needed to barge in, so short echoes don't. */
export const BARGE_IN_MS = 300;
/** shortcut: hard cap on one turn; upgrade to streaming STT if long monologues matter. */
export const MAX_TURN_MS = 60_000;

export class VoiceChatController<Audio> {
	private state: VoiceChatState = "off";
	/** Bumped on stop/barge-in/new turn; stale async continuations check it. */
	private token = 0;
	private speechStartedAt: number | null = null;
	private lastLoudAt = 0;
	private loudSince: number | null = null;
	private awaitingReply = false;
	private replyDone = false;
	private consumed = 0;
	private queue: Promise<Audio>[] = [];
	private playing = false;

	constructor(
		private deps: VoiceChatDeps<Audio>,
		private config: () => VoiceChatConfig,
	) {}

	getState(): VoiceChatState {
		return this.state;
	}

	start(): void {
		if (this.state !== "off") return;
		this.listen();
	}

	stop(): void {
		if (this.state === "off") return;
		this.token++;
		this.awaitingReply = false;
		this.queue = [];
		this.deps.cancelRecording();
		this.deps.stopPlayback();
		this.setState("off");
	}

	/** Feed one mic level sample (RMS 0-1) at time `now` (ms). */
	onLevel(rms: number, now: number): void {
		const { silenceThreshold, silenceMs, bargeIn } = this.config();
		const loud = rms >= silenceThreshold;
		if (this.state === "listening") {
			if (loud) {
				this.speechStartedAt ??= now;
				this.lastLoudAt = now;
			} else if (
				this.speechStartedAt !== null &&
				now - this.lastLoudAt >= silenceMs
			) {
				void this.endTurn();
				return;
			}
			if (
				this.speechStartedAt !== null &&
				now - this.speechStartedAt >= MAX_TURN_MS
			) {
				void this.endTurn();
			}
		} else if (this.state === "speaking" && bargeIn) {
			if (!loud) {
				this.loudSince = null;
				return;
			}
			this.loudSince ??= now;
			if (now - this.loudSince >= BARGE_IN_MS) this.interrupt(now);
		}
	}

	/** Call whenever the reply text may have grown. */
	onReplyText(): void {
		if (this.awaitingReply) this.pump();
	}

	/** Stop the spoken reply (and generation, if still running) and listen. */
	interrupt(now = 0): void {
		if (this.state !== "speaking" && this.state !== "thinking") return;
		this.token++;
		this.queue = [];
		this.deps.stopPlayback();
		if (this.awaitingReply && !this.replyDone) this.deps.cancelReply();
		this.awaitingReply = false;
		this.listen();
		if (now) {
			// The user is already talking: count it as the start of the turn.
			this.speechStartedAt = now;
			this.lastLoudAt = now;
		}
	}

	private listen(): void {
		this.speechStartedAt = null;
		this.loudSince = null;
		this.playing = false;
		this.setState("listening");
		this.deps.startRecording();
	}

	private async endTurn(): Promise<void> {
		const token = ++this.token;
		this.setState("thinking");
		let transcript: string;
		try {
			transcript = (await this.deps.finishRecording()).trim();
		} catch {
			return this.fail(token, "Couldn't transcribe what you said.");
		}
		if (token !== this.token) return;
		if (!transcript) return this.listen(); // silence: re-listen quietly

		this.awaitingReply = true;
		this.replyDone = false;
		this.consumed = 0;
		this.queue = [];
		try {
			await this.deps.send(transcript);
		} catch {
			return this.fail(token, "Couldn't send your message.");
		}
		if (token !== this.token) return;
		this.replyDone = true;
		this.pump();
	}

	private pump(): void {
		const token = this.token;
		const text = this.deps.getReplyText();
		const { chunks, next } = extractSpeakable(
			text,
			this.consumed,
			this.replyDone,
		);
		this.consumed = next;
		if (chunks.length > 0) {
			const synth = this.deps.synthesize(chunks.join(" "));
			synth.catch(() => undefined); // handled when played
			this.queue.push(synth);
		}
		if (!this.playing) void this.playLoop(token);
	}

	private async playLoop(token: number): Promise<void> {
		this.playing = true;
		while (this.queue.length > 0) {
			const next = this.queue.shift()!;
			this.setState("speaking");
			try {
				const audio = await next;
				if (token !== this.token) return;
				await this.deps.play(audio);
			} catch {
				return this.fail(token, "Couldn't speak the reply.");
			}
			if (token !== this.token) return;
		}
		this.playing = false;
		if (this.replyDone) {
			this.awaitingReply = false;
			this.listen();
		} else {
			this.setState("thinking");
		}
	}

	private fail(token: number, message: string): void {
		if (token !== this.token) return;
		this.stop();
		this.deps.onError(message);
	}

	private setState(state: VoiceChatState): void {
		if (this.state === state) return;
		this.state = state;
		this.deps.onState(state);
	}
}

export type DictationState = "idle" | "recording" | "transcribing";

export interface DictationDeps {
	startRecording(): Promise<void>;
	finishRecording(): Promise<string>;
	cancelRecording(): void;
	/** Insert the transcript into the composer. Dictation never sends. */
	insert(text: string): void;
	onState(state: DictationState): void;
	onError(message: string): void;
}

export class DictationController {
	private state: DictationState = "idle";

	constructor(private deps: DictationDeps) {}

	getState(): DictationState {
		return this.state;
	}

	async toggle(): Promise<void> {
		if (this.state === "idle") {
			this.setState("recording");
			try {
				await this.deps.startRecording();
			} catch {
				this.setState("idle");
				this.deps.onError("Couldn't use the microphone.");
			}
		} else if (this.state === "recording") {
			await this.finish();
		}
	}

	cancel(): void {
		if (this.state !== "recording") return;
		this.deps.cancelRecording();
		this.setState("idle");
	}

	private async finish(): Promise<void> {
		this.setState("transcribing");
		try {
			const text = (await this.deps.finishRecording()).trim();
			if (text) this.deps.insert(text);
		} catch {
			this.deps.onError("Couldn't transcribe the recording.");
		} finally {
			this.setState("idle");
		}
	}

	private setState(state: DictationState): void {
		this.state = state;
		this.deps.onState(state);
	}
}

/** Insert `text` at the selection, padding with spaces so words don't merge. */
export function insertAtCursor(
	value: string,
	start: number,
	end: number,
	text: string,
): { value: string; cursor: number } {
	const before = value.slice(0, start);
	const after = value.slice(end);
	const pre = before && !/\s$/.test(before) ? " " : "";
	const post = after && !/^\s/.test(after) ? " " : "";
	const inserted = pre + text + post;
	return {
		value: before + inserted + after,
		cursor: before.length + pre.length + text.length,
	};
}
