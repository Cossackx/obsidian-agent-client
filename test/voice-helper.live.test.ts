/**
 * Live round trip through Hermes's configured STT/TTS. Opt-in only (real
 * provider calls): VOICE_LIVE=1 HERMES_CMD=<path to hermes> npx vitest run test/voice-helper.live.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	VoiceHelper,
	resolveHermesRuntime,
} from "../src/services/voice-helper";

const live = process.env.VOICE_LIVE === "1";

describe.skipIf(!live)("voice helper live round trip", () => {
	it("speaks a phrase and transcribes it back", async () => {
		const cmd = process.env.HERMES_CMD ?? "hermes";
		const helper = new VoiceHelper(() =>
			resolveHermesRuntime(cmd, ["--print-runtime-command"], {
				shell: process.platform === "win32",
				env: process.env,
			}),
		);
		await new Promise<void>((resolve, reject) => {
			const check = () => {
				const s = helper.getStatus();
				if (s.state === "ready") resolve();
				if (s.state === "unavailable") reject(new Error(s.reason));
			};
			helper.subscribe(check);
			helper.start();
			check();
		});
		const phrase = "The quick brown fox jumps over the lazy dog.";
		const spoken = await helper.speak(phrase);
		const ext =
			spoken.mime === "audio/ogg"
				? ".ogg"
				: spoken.mime === "audio/wav"
					? ".wav"
					: ".mp3";
		const transcript = await helper.transcribe(spoken.audio, ext);
		helper.dispose();
		console.warn(
			`[roundtrip] mime=${spoken.mime} bytes=${Math.round((spoken.audio.length * 3) / 4)} transcript=${JSON.stringify(transcript)}`,
		);
		const norm = (s: string) =>
			s
				.toLowerCase()
				.replace(/[^a-z ]/g, "")
				.trim();
		expect(norm(transcript)).toBe(norm(phrase));
	}, 180_000);
});
