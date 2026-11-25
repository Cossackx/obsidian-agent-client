import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InputToolbar } from "../src/ui/InputToolbar";
import type { VoiceControlsProps } from "../src/ui/VoiceControls";
import type { SessionConfigOption } from "../src/types/session";
import {
	VoiceHelper,
	parseRuntimeCommand,
	type VoiceHelperStatus,
} from "../src/services/voice-helper";

const select = (id: string, name: string): SessionConfigOption => ({
	id,
	name,
	type: "select",
	currentValue: "a",
	options: [
		{ value: "a", name: `${name} A` },
		{ value: "b", name: `${name} B` },
	],
});

const configOptions = [
	select("model", "Model"),
	select("reasoning_effort", "Reasoning"),
	select("service_tier", "Service tier"),
];

function voice(status: VoiceHelperStatus): VoiceControlsProps {
	return {
		enabled: true,
		status,
		dictationState: "idle",
		voiceChatState: "off",
		voiceError: null,
		clearVoiceError: vi.fn(),
		toggleDictation: vi.fn(),
		toggleVoiceChat: vi.fn(),
		interruptSpeech: vi.fn(),
		retry: vi.fn(),
		canSend: true,
	};
}

function render(props: {
	hidden?: string[];
	voice?: VoiceControlsProps;
}): string {
	return renderToStaticMarkup(
		createElement(InputToolbar, {
			isSending: false,
			isButtonDisabled: false,
			hasContent: false,
			onSendOrStop: () => undefined,
			configOptions,
			isSessionReady: true,
			hiddenConfigOptionIds: props.hidden,
			voice: props.voice,
		}),
	);
}

describe("composer toolbar", () => {
	it("hides service_tier by id and keeps the other pickers", () => {
		const html = render({ hidden: ["service_tier"] });
		expect(html).not.toContain("Service tier");
		expect(html).toContain("Model A");
		expect(html).toContain("Reasoning A");
	});

	it("shows service_tier again when it is removed from the hidden list", () => {
		expect(render({ hidden: [] })).toContain("Service tier A");
	});

	it("shows Dictate and Voice chat when the helper is healthy", () => {
		const html = render({ voice: voice({ state: "ready" }) });
		expect(html).toContain('aria-label="Dictate"');
		expect(html).toContain('aria-label="Voice chat"');
	});

	it("hides voice controls and gives a plain reason when the helper is unavailable", () => {
		const html = render({
			voice: voice({
				state: "unavailable",
				reason: "Hermes voice tools could not be loaded.",
			}),
		});
		expect(html).not.toContain('aria-label="Dictate"');
		expect(html).not.toContain('aria-label="Voice chat"');
		expect(html).toContain(
			"Voice unavailable: Hermes voice tools could not be loaded.",
		);
		expect(html).not.toMatch(/Traceback|Error:/);
	});

	it("shows nothing while the helper is starting or voice is disabled", () => {
		const base = render({});
		expect(render({ voice: voice({ state: "starting" }) })).toBe(base);
		expect(
			render({ voice: { ...voice({ state: "ready" }), enabled: false } }),
		).toBe(base);
	});

	it("shows a recording indicator while dictating", () => {
		const html = render({
			voice: {
				...voice({ state: "ready" }),
				dictationState: "recording",
			},
		});
		expect(html).toContain("Recording…");
		expect(html).toContain("agent-client-voice-recording");
		expect(html).toContain("Stop dictation (Esc)");
	});
});

/** Fake child process speaking the helper protocol. */
function fakeChild(
	script: (req: Record<string, unknown>) => unknown,
	startup: unknown,
) {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	});
	setTimeout(() => child.stdout.write(JSON.stringify(startup) + "\n"), 0);
	child.stdin.on("data", (d: Buffer) => {
		for (const line of d.toString().split("\n").filter(Boolean)) {
			const req = JSON.parse(line) as Record<string, unknown>;
			child.stdout.write(
				JSON.stringify({ id: req.id, ...(script(req) as object) }) +
					"\n",
			);
		}
	});
	return child;
}

async function waitFor(helper: VoiceHelper, state: string) {
	for (let i = 0; i < 50 && helper.getStatus().state !== state; i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	expect(helper.getStatus().state).toBe(state);
}

const runtime = async () => ({ python: "py", root: "C:\\h" });
const quiet = { log: () => undefined, error: () => undefined };

describe("VoiceHelper", () => {
	it("round-trips transcribe/speak requests over JSON lines", async () => {
		const spawn = vi.fn(() =>
			fakeChild(
				(req) =>
					req.op === "transcribe"
						? { ok: true, transcript: "hello" }
						: { ok: true, audio: "QUJD", mime: "audio/mpeg" },
				{ type: "ready" },
			),
		);
		const h = new VoiceHelper(runtime, quiet, spawn as never);
		h.start();
		await waitFor(h, "ready");
		await expect(h.transcribe("AAAA", ".webm")).resolves.toBe("hello");
		await expect(h.speak("hi")).resolves.toEqual({
			audio: "QUJD",
			mime: "audio/mpeg",
		});
		const [, args, opts] = spawn.mock.calls[0] as unknown as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv },
		];
		expect(args.slice(0, 2)).toEqual(["-I", "-c"]);
		expect(args[3]).toBe("C:\\h");
		expect(opts.env.PYTHONPATH).toBeUndefined();
		h.dispose();
	});

	it("reports the helper's plain-language reason when Hermes imports fail", async () => {
		const spawn = vi.fn(() =>
			fakeChild(() => ({}), {
				type: "unavailable",
				reason: "Hermes voice tools could not be loaded.",
				detail: "ModuleNotFoundError: tools",
			}),
		);
		const h = new VoiceHelper(runtime, quiet, spawn as never);
		h.start();
		await waitFor(h, "unavailable");
		expect(h.getStatus()).toEqual({
			state: "unavailable",
			reason: "Hermes voice tools could not be loaded.",
		});
		await expect(h.transcribe("", ".webm")).rejects.toThrow(
			"Voice is not available.",
		);
	});

	it("is unavailable when the Hermes runtime can't be resolved", async () => {
		const h = new VoiceHelper(
			() => Promise.reject(new Error("Hermes was not found.")),
			quiet,
		);
		h.start();
		await waitFor(h, "unavailable");
		expect(h.getStatus()).toEqual({
			state: "unavailable",
			reason: "Hermes was not found.",
		});
	});

	it("parses hermes --print-runtime-command output", () => {
		const out =
			'["C:\\\\Users\\\\a\\\\hermes\\\\venv\\\\Scripts\\\\python.exe", "-c", "import sys; sys.path.insert(0, \'C:\\\\\\\\Users\\\\\\\\a\\\\\\\\hermes-agent\'); import hermes_cli"]\n';
		expect(parseRuntimeCommand(out)).toEqual({
			python: "C:\\Users\\a\\hermes\\venv\\Scripts\\python.exe",
			root: "C:\\Users\\a\\hermes-agent",
		});
		expect(parseRuntimeCommand("usage: hermes")).toBeNull();
	});
});
