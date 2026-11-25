import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { VOICE_HELPER_SCRIPT } from "./voice-helper-script";

/**
 * Plugin-owned voice helper: a long-lived Python process started with
 * Hermes's own interpreter that serves transcribe/speak over JSON lines.
 * No API key ever touches the plugin; Hermes's configured STT/TTS providers
 * do the work, exactly as for Hermes Desktop.
 */

export type VoiceHelperStatus =
	| { state: "off" }
	| { state: "starting" }
	| { state: "ready" }
	| { state: "unavailable"; reason: string };

export interface HermesRuntime {
	python: string;
	root: string;
}

export interface SpokenAudio {
	/** base64 audio bytes */
	audio: string;
	mime: string;
}

type SpawnFn = typeof nodeSpawn;
type Logger = {
	log: (...a: unknown[]) => void;
	error: (...a: unknown[]) => void;
};

const str = (v: unknown, fallback: string): string =>
	typeof v === "string" ? v : fallback;

const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Parse `hermes --print-runtime-command` output: a JSON argv whose first
 * element is Hermes's Python and whose `-c` code inserts the checkout root
 * into sys.path. Returns null when the shape is not recognised.
 */
export function parseRuntimeCommand(stdout: string): HermesRuntime | null {
	const line = stdout
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.startsWith("["));
	if (!line) return null;
	let argv: unknown;
	try {
		argv = JSON.parse(line);
	} catch {
		return null;
	}
	if (!Array.isArray(argv) || typeof argv[0] !== "string") return null;
	const code = argv.find(
		(a): a is string =>
			typeof a === "string" && a.includes("sys.path.insert"),
	);
	const match = code?.match(/sys\.path\.insert\(0, '((?:[^'\\]|\\.)*)'\)/);
	if (!match) return null;
	// Undo Python string-literal escaping ('C:\\Users' -> C:\Users).
	const root = match[1].replace(/\\(.)/g, "$1");
	return { python: argv[0], root };
}

/** Run `<hermesCommand> --print-runtime-command` and parse its argv. */
export function resolveHermesRuntime(
	command: string,
	args: string[],
	options: { shell: boolean; env: NodeJS.ProcessEnv },
	spawnFn: SpawnFn = nodeSpawn,
): Promise<HermesRuntime> {
	return new Promise((resolve, reject) => {
		let out = "";
		const child = spawnFn(command, args, {
			shell: options.shell,
			env: options.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Hermes did not answer in time."));
		}, 30_000);
		child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
		child.on("error", () => {
			clearTimeout(timer);
			reject(
				new Error(
					"Hermes was not found. Check the Hermes Agent command in settings.",
				),
			);
		});
		child.on("close", () => {
			clearTimeout(timer);
			const runtime = parseRuntimeCommand(out);
			if (runtime) resolve(runtime);
			else
				reject(
					new Error(
						"This Hermes version can't report its Python runtime, so voice can't start.",
					),
				);
		});
	});
}

interface Pending {
	resolve: (v: Record<string, unknown>) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class VoiceHelper {
	private status: VoiceHelperStatus = { state: "off" };
	private listeners = new Set<() => void>();
	private child: ChildProcess | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private buffer = "";

	constructor(
		private resolveRuntime: () => Promise<HermesRuntime>,
		private logger: Logger = console,
		private spawnFn: SpawnFn = nodeSpawn,
	) {}

	getStatus = (): VoiceHelperStatus => this.status;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** Start (or retry after failure). No-op while starting or ready. */
	start(): void {
		if (this.status.state === "starting" || this.status.state === "ready")
			return;
		this.setStatus({ state: "starting" });
		this.resolveRuntime().then(
			(runtime) => this.launch(runtime),
			(err: Error) => this.fail(err.message),
		);
	}

	transcribe(audioBase64: string, ext: string): Promise<string> {
		return this.request({ op: "transcribe", audio: audioBase64, ext }).then(
			(r) => str(r.transcript, ""),
		);
	}

	speak(text: string): Promise<SpokenAudio> {
		return this.request({ op: "speak", text }).then((r) => ({
			audio: str(r.audio, ""),
			mime: str(r.mime, "audio/mpeg"),
		}));
	}

	dispose(): void {
		const child = this.child;
		this.child = null;
		this.rejectAll("Voice stopped.");
		child?.stdin?.end(); // helper exits on stdin EOF
		child?.kill();
		this.setStatus({ state: "off" });
	}

	private launch(runtime: HermesRuntime): void {
		if (this.status.state !== "starting") return; // disposed meanwhile
		const env = { ...process.env };
		delete env.PYTHONPATH; // Hermes terminals export a shadowing PYTHONPATH
		delete env.PYTHONHOME;
		delete env.VIRTUAL_ENV;
		let child: ChildProcess;
		try {
			child = this.spawnFn(
				runtime.python,
				["-I", "-c", VOICE_HELPER_SCRIPT, runtime.root],
				{ env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
			);
		} catch (e) {
			this.logger.error("[VoiceHelper] spawn failed", e);
			this.fail("Hermes's Python could not be started.");
			return;
		}
		this.child = child;
		this.buffer = "";
		const startTimer = setTimeout(
			() => this.fail("The Hermes voice helper did not start in time."),
			START_TIMEOUT_MS,
		);
		child.stdout?.on("data", (d: Buffer) => {
			this.buffer += d.toString("utf8");
			let nl: number;
			while ((nl = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, nl).trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (line) this.onLine(line, startTimer);
			}
		});
		child.stderr?.on("data", (d: Buffer) =>
			this.logger.log("[VoiceHelper]", d.toString("utf8").trim()),
		);
		child.on("error", (e) => {
			clearTimeout(startTimer);
			this.logger.error("[VoiceHelper] process error", e);
			if (this.child === child)
				this.fail("Hermes's Python could not be started.");
		});
		child.on("exit", () => {
			clearTimeout(startTimer);
			if (this.child === child && this.status.state !== "unavailable")
				this.fail("The Hermes voice helper stopped.");
		});
	}

	private onLine(
		line: string,
		startTimer: ReturnType<typeof setTimeout>,
	): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (msg.type === "ready") {
			clearTimeout(startTimer);
			this.setStatus({ state: "ready" });
			return;
		}
		if (msg.type === "unavailable") {
			clearTimeout(startTimer);
			this.logger.error("[VoiceHelper] unavailable:", msg.detail);
			this.fail(str(msg.reason, "Hermes voice is unavailable."));
			return;
		}
		const pending = this.pending.get(Number(msg.id));
		if (!pending) return;
		this.pending.delete(Number(msg.id));
		clearTimeout(pending.timer);
		if (msg.ok) pending.resolve(msg);
		else {
			this.logger.error("[VoiceHelper] request failed:", msg.error);
			pending.reject(new Error(str(msg.error, "Voice request failed")));
		}
	}

	private request(
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const child = this.child;
		if (this.status.state !== "ready" || !child?.stdin) {
			return Promise.reject(new Error("Voice is not available."));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Hermes took too long to answer."));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin!.write(JSON.stringify({ id, ...body }) + "\n");
		});
	}

	private fail(reason: string): void {
		const child = this.child;
		this.child = null;
		child?.kill();
		this.rejectAll(reason);
		this.setStatus({ state: "unavailable", reason });
	}

	private rejectAll(reason: string): void {
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error(reason));
		}
		this.pending.clear();
	}

	private setStatus(status: VoiceHelperStatus): void {
		this.status = status;
		for (const l of this.listeners) l();
	}
}
