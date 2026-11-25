/**
 * Browser microphone capture (getUserMedia + MediaRecorder) with an optional
 * WebAudio level meter, and data-URL audio playback.
 */

import type { SpokenAudio } from "./voice-helper";

const LEVEL_INTERVAL_MS = 50;

export class MicCapture {
	private stream: MediaStream | null = null;
	private ctx: AudioContext | null = null;
	private timer: number | null = null;
	private recording: { recorder: MediaRecorder; done: Promise<Blob> } | null =
		null;

	get isOpen(): boolean {
		return this.stream !== null;
	}

	/** Open the mic; `onLevel` receives RMS (0-1) every 50ms. */
	async open(onLevel?: (rms: number) => void): Promise<void> {
		if (this.stream) return;
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		});
		if (!onLevel) return;
		const ctx = new AudioContext();
		this.ctx = ctx;
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 1024;
		ctx.createMediaStreamSource(this.stream).connect(analyser);
		const buf = new Float32Array(analyser.fftSize);
		this.timer = window.setInterval(() => {
			analyser.getFloatTimeDomainData(buf);
			let sum = 0;
			for (const v of buf) sum += v * v;
			onLevel(Math.sqrt(sum / buf.length));
		}, LEVEL_INTERVAL_MS);
	}

	startRecording(): void {
		if (!this.stream) throw new Error("Microphone is not open");
		this.cancelRecording();
		const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
			? "audio/webm;codecs=opus"
			: "";
		const recorder = new MediaRecorder(
			this.stream,
			mimeType ? { mimeType } : undefined,
		);
		const chunks: Blob[] = [];
		recorder.ondataavailable = (e) => {
			if (e.data.size > 0) chunks.push(e.data);
		};
		const done = new Promise<Blob>((resolve) => {
			recorder.onstop = () =>
				resolve(new Blob(chunks, { type: recorder.mimeType }));
		});
		recorder.start();
		this.recording = { recorder, done };
	}

	/** Stop recording and return the audio, or null if nothing was recording. */
	stopRecording(): Promise<Blob | null> {
		const rec = this.recording;
		this.recording = null;
		if (!rec || rec.recorder.state === "inactive")
			return Promise.resolve(null);
		rec.recorder.stop();
		return rec.done;
	}

	cancelRecording(): void {
		const rec = this.recording;
		this.recording = null;
		if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
	}

	close(): void {
		this.cancelRecording();
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		void this.ctx?.close();
		this.ctx = null;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
	}
}

/** Recorded blob -> base64 + file extension for the helper. */
export async function blobToAudioPayload(
	blob: Blob,
): Promise<{ base64: string; ext: string }> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	const ext = blob.type.includes("ogg")
		? ".ogg"
		: blob.type.includes("mp4")
			? ".m4a"
			: ".webm";
	return { base64: btoa(binary), ext };
}

export class AudioPlayer {
	private el: HTMLAudioElement | null = null;
	private finish: (() => void) | null = null;

	/** Play to the end; resolves early if stop() is called. */
	play(audio: SpokenAudio): Promise<void> {
		this.stop();
		return new Promise((resolve, reject) => {
			const el = new Audio(`data:${audio.mime};base64,${audio.audio}`);
			this.el = el;
			const done = (err?: Error) => {
				if (this.el === el) {
					this.el = null;
					this.finish = null;
				}
				if (err) reject(err);
				else resolve();
			};
			this.finish = () => done();
			el.onended = () => done();
			el.onerror = () => done(new Error("Audio playback failed"));
			el.play().catch(() => done(new Error("Audio playback failed")));
		});
	}

	stop(): void {
		this.el?.pause();
		this.finish?.();
	}
}
