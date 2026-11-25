import { describe, expect, it, vi } from "vitest";
import {
	BARGE_IN_MS,
	DictationController,
	VoiceChatController,
	insertAtCursor,
	type VoiceChatDeps,
	type VoiceChatState,
} from "../src/services/voice-chat";
import { cleanForSpeech, extractSpeakable } from "../src/services/speech-text";

const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function setup(transcripts: string[]) {
	const states: VoiceChatState[] = [];
	let reply = "";
	let sendDone = deferred();
	const playing: Array<{ text: string; done: () => void }> = [];
	const deps = {
		startRecording: vi.fn(),
		finishRecording: vi.fn(async () => transcripts.shift() ?? ""),
		cancelRecording: vi.fn(),
		send: vi.fn(() => sendDone.promise),
		getReplyText: () => reply,
		cancelReply: vi.fn(),
		synthesize: vi.fn(async (t: string) => t),
		play: vi.fn(
			(t: string) =>
				new Promise<void>((done) => playing.push({ text: t, done })),
		),
		stopPlayback: vi.fn(() => playing.splice(0).forEach((p) => p.done())),
		onState: (s: VoiceChatState) => states.push(s),
		onError: vi.fn(),
	} satisfies VoiceChatDeps<string>;
	const cfg = { silenceThreshold: 0.1, silenceMs: 1000, bargeIn: true };
	const vc = new VoiceChatController(deps, () => cfg);
	return {
		vc,
		deps,
		states,
		cfg,
		playing,
		setReply: (t: string) => {
			reply = t;
			vc.onReplyText();
		},
		finishReply: async () => {
			sendDone.resolve();
			await flush();
			sendDone = deferred();
		},
	};
}

/** Speak from t0 for 500ms, then stay quiet until silence ends the turn. */
async function speakTurn(vc: VoiceChatController<string>, t0: number) {
	vc.onLevel(0.5, t0);
	vc.onLevel(0.5, t0 + 500);
	vc.onLevel(0.01, t0 + 1000);
	vc.onLevel(0.01, t0 + 1600);
	await flush();
}

describe("VoiceChatController", () => {
	it("listens, ends the turn on a pause, sends, speaks the reply as it streams, then listens again", async () => {
		const t = setup(["what time is it"]);
		t.vc.start();
		expect(t.vc.getState()).toBe("listening");
		expect(t.deps.startRecording).toHaveBeenCalledTimes(1);

		// quiet before speech never ends a turn
		t.vc.onLevel(0.01, 0);
		t.vc.onLevel(0.01, 5000);
		expect(t.deps.finishRecording).not.toHaveBeenCalled();

		await speakTurn(t.vc, 6000);
		expect(t.deps.send).toHaveBeenCalledWith("what time is it");
		expect(t.vc.getState()).toBe("thinking");

		// first sentence is spoken before the reply finishes
		t.setReply("It is noon. And");
		await flush();
		expect(t.playing.map((p) => p.text)).toEqual(["It is noon."]);
		expect(t.vc.getState()).toBe("speaking");

		t.setReply("It is noon. And sunny.");
		await t.finishReply();
		t.playing.shift()!.done();
		await flush();
		expect(t.playing.map((p) => p.text)).toEqual(["And sunny."]);
		t.playing.shift()!.done();
		await flush();

		expect(t.vc.getState()).toBe("listening");
		expect(t.deps.startRecording).toHaveBeenCalledTimes(2);
		expect(t.states).toEqual([
			"listening",
			"thinking",
			"speaking",
			"listening",
		]);
	});

	it("re-listens silently on an empty transcript", async () => {
		const t = setup([""]);
		t.vc.start();
		await speakTurn(t.vc, 0);
		expect(t.deps.send).not.toHaveBeenCalled();
		expect(t.deps.onError).not.toHaveBeenCalled();
		expect(t.vc.getState()).toBe("listening");
		expect(t.deps.startRecording).toHaveBeenCalledTimes(2);
	});

	it("barge-in stops playback, cancels an unfinished reply, and starts a new turn", async () => {
		const t = setup(["tell me a story", "stop"]);
		t.vc.start();
		await speakTurn(t.vc, 0);
		t.setReply("Once upon a time. ");
		await flush();
		expect(t.vc.getState()).toBe("speaking");

		// a short blip does not interrupt
		t.vc.onLevel(0.5, 10_000);
		t.vc.onLevel(0.01, 10_100);
		expect(t.deps.stopPlayback).not.toHaveBeenCalled();

		t.vc.onLevel(0.5, 11_000);
		t.vc.onLevel(0.5, 11_000 + BARGE_IN_MS);
		expect(t.deps.stopPlayback).toHaveBeenCalled();
		expect(t.deps.cancelReply).toHaveBeenCalled();
		expect(t.vc.getState()).toBe("listening");

		// the barge-in speech already counts: a pause ends this turn
		t.vc.onLevel(0.01, 11_000 + BARGE_IN_MS + 1100);
		await flush();
		expect(t.deps.send).toHaveBeenLastCalledWith("stop");
	});

	it("does not barge in when disabled", async () => {
		const t = setup(["hi"]);
		t.cfg.bargeIn = false;
		t.vc.start();
		await speakTurn(t.vc, 0);
		t.setReply("Hello there. ");
		await flush();
		t.vc.onLevel(0.5, 10_000);
		t.vc.onLevel(0.5, 12_000);
		expect(t.deps.stopPlayback).not.toHaveBeenCalled();
		expect(t.vc.getState()).toBe("speaking");
	});

	it("stop ends voice chat at any point and ignores late results", async () => {
		const t = setup(["hello"]);
		t.vc.start();
		await speakTurn(t.vc, 0);
		t.setReply("Hi. ");
		await flush();
		t.vc.stop();
		expect(t.vc.getState()).toBe("off");
		expect(t.deps.cancelRecording).toHaveBeenCalled();
		expect(t.deps.stopPlayback).toHaveBeenCalled();
		t.setReply("Hi. More text. ");
		await t.finishReply();
		expect(t.vc.getState()).toBe("off");
		expect(t.deps.startRecording).toHaveBeenCalledTimes(1);
	});

	it("reports a plain-language error and stops when transcription fails", async () => {
		const t = setup([]);
		t.deps.finishRecording.mockRejectedValueOnce(
			new Error("Traceback ..."),
		);
		t.vc.start();
		await speakTurn(t.vc, 0);
		expect(t.vc.getState()).toBe("off");
		expect(t.deps.onError).toHaveBeenCalledWith(
			"Couldn't transcribe what you said.",
		);
	});
});

describe("DictationController", () => {
	it("inserts the transcript and never sends", async () => {
		const insert = vi.fn();
		const d = new DictationController({
			startRecording: vi.fn(async () => undefined),
			finishRecording: vi.fn(async () => " hello world "),
			cancelRecording: vi.fn(),
			insert,
			onState: vi.fn(),
			onError: vi.fn(),
		});
		await d.toggle();
		expect(d.getState()).toBe("recording");
		await d.toggle();
		expect(insert).toHaveBeenCalledWith("hello world");
		expect(d.getState()).toBe("idle");
		// The controller has no send dependency at all; nothing else was called.
		expect(Object.keys(d)).not.toContain("send");
	});

	it("inserts nothing for silence and cancel discards the recording", async () => {
		const insert = vi.fn();
		const cancelRecording = vi.fn();
		const d = new DictationController({
			startRecording: vi.fn(async () => undefined),
			finishRecording: vi.fn(async () => ""),
			cancelRecording,
			insert,
			onState: vi.fn(),
			onError: vi.fn(),
		});
		await d.toggle();
		await d.toggle();
		expect(insert).not.toHaveBeenCalled();
		await d.toggle();
		d.cancel();
		expect(cancelRecording).toHaveBeenCalled();
		expect(d.getState()).toBe("idle");
	});

	it("insertAtCursor pads with spaces and returns the new cursor", () => {
		expect(insertAtCursor("ab", 1, 1, "X")).toEqual({
			value: "a X b",
			cursor: 3,
		});
		expect(insertAtCursor("", 0, 0, "hi")).toEqual({
			value: "hi",
			cursor: 2,
		});
		expect(insertAtCursor("one two", 4, 7, "three")).toEqual({
			value: "one three",
			cursor: 9,
		});
	});
});

describe("speech text", () => {
	it("waits for complete sentences while streaming", () => {
		expect(extractSpeakable("Hello there. How", 0, false)).toEqual({
			chunks: ["Hello there."],
			next: 12,
		});
		expect(extractSpeakable("Hello there. How", 12, true).chunks).toEqual([
			"How",
		]);
	});

	it("replaces code blocks with a placeholder and waits for unclosed fences", () => {
		const text = "Run this:\n```bash\nrm -rf /tmp/x\n```\nDone.";
		expect(extractSpeakable(text, 0, true).chunks).toEqual([
			"Run this:",
			"Code block omitted.",
			"Done.",
		]);
		const partial = extractSpeakable("Try:\n```js\nconst a", 0, false);
		expect(partial.chunks).toEqual(["Try:"]);
	});

	it("drops paths, URLs and markdown noise", () => {
		expect(
			cleanForSpeech(
				"**Edited** `C:\\Users\\me\\notes\\a.md` see https://x.y/z and [docs](http://d)",
			),
		).toBe("Edited see a link and docs");
		expect(cleanForSpeech("- Open src/ui/InputArea.tsx now")).toBe(
			"Open a path now",
		);
		expect(cleanForSpeech("---")).toBe("");
	});
});
