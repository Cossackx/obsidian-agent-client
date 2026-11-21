import { ContextTray } from "../src/ui/ContextTray";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { ChatContextProvider } from "../src/ui/ChatContext";
import { ChatPanel } from "../src/ui/ChatPanel";
import { useAgentMessages } from "../src/hooks/useAgentMessages";
import { CompanionStorage } from "../src/services/companion-storage";
import { ChatViewRegistry } from "../src/services/view-registry";
import { InputArea } from "../src/ui/InputArea";
import { ChatHeader } from "../src/ui/ChatHeader";
import { MessageList } from "../src/ui/MessageList";
import { TFile, FileSystemAdapter } from "obsidian";
const m = vi.hoisted(() => ({
	notice: vi.fn(),
	confirm: vi.fn(),
	agent: undefined as any,
	picker: vi.fn(),
	menu: [] as any[],
}));
vi.mock("obsidian", async (orig) => ({
	...(await orig<any>()),
	Modal: class {},
	MarkdownView: class {},
	FuzzySuggestModal: class {},
	FileSystemAdapter: class {
		getFullPath(p) {
			return "/test/" + p;
		}
	},
	arrayBufferToBase64: () => "AA==",
	Menu: class {
		addItem(fn) {
			let row: any = {
				setTitle(s) {
					this.title = s;
					return this;
				},
				onClick(f) {
					this.click = f;
					return this;
				},
			};
			fn(row);
			m.menu.push(row);
		}
		showAtMouseEvent() {}
	},
	Notice: class {
		constructor(s) {
			m.notice(s);
		}
	},
}));
vi.mock("../src/hooks/useAgent", () => ({
	useAgent: (...args) => m.agent(...args),
}));
vi.mock("../src/ui/SessionHistoryModal", () => ({
	SessionHistoryModal: class {
		constructor(_app, props) {
			m.history = props;
		}
		open() {}
		updateProps(props) {
			m.history = props;
		}
	},
}));
vi.mock("../src/hooks/useSettings", () => ({
	useSettingsSelector: (p, sel) => sel(p.settings),
	useSettings: (p) => p.settings,
}));
vi.mock("../src/ui/ContextPreviewModal", () => ({
	confirmPayload: (...a) => m.confirm(...a),
}));
vi.mock("../src/ui/ReplyTargetPicker", () => ({
	chooseReplyTarget: (...a) => m.picker(...a),
}));
vi.mock("../src/ui/MessageList", () => ({ MessageList: () => null }));
const noop = () => {};
const doc = { nodeType: 9, addEventListener: noop, activeElement: null };
let root: any;
function latch() {
	let go!: () => void;
	const p = new Promise<void>((r) => (go = r));
	return { p, go };
}
function search(e: any, check: (e: any) => boolean): any {
	if (Array.isArray(e)) {
		for (const child of e) {
			const hit = search(child, check);
			if (hit) return hit;
		}
	} else if (e?.props) {
		if (check(e)) return e;
		return search(e.props.children, check);
	}
}
beforeEach(() => {
	vi.stubGlobal("window", {
		document: doc,
		HTMLIFrameElement: class {},
		requestAnimationFrame: () => 0,
		setTimeout,
		clearTimeout,
	});
	vi.stubGlobal("document", doc);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	m.confirm.mockReset().mockResolvedValue(false);
	m.notice.mockClear();
	m.menu.length = 0;
});
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	root = null;
	vi.unstubAllGlobals();
});

async function mount(opts: any = {}) {
	const files = new Map();
	let failed = false,
		verifyNext = false,
		failVerify = false;
	const adapter = {
		exists: async (p) => p === "side" || files.has(p),
		read: async (p) => {
			if (failVerify) {
				failVerify = false;
				throw Error("transient verification error");
			}
			return files.get(p);
		},
		mkdir: noop,
		write: async (p, t) => {
			if (failed) {
				failed = false;
				throw Error("test persistence failure");
			}
			files.set(p, t);
			if (verifyNext) {
				verifyNext = false;
				failVerify = true;
			}
		},
		list: async () => ({ files: [...files.keys()], folders: [] }),
	};
	const storage = new CompanionStorage(adapter as never, "side");
	const prompt = vi.fn(async () => {}),
		create = vi.fn(),
		restart = vi.fn(),
		session = {
			state: "ready",
			sessionId: "A",
			agentId: "reviewer",
			agentCapabilities: { sessionCapabilities: { fork: {} } },
			promptCapabilities: {
				embeddedContext: opts.embedded ?? true,
				image: true,
			},
		};
	const messages = opts.messages ?? [];
	const wire = { hasLiveSession: () => true, sendPrompt: prompt };
	const file = Object.assign(new TFile("Brief.md", "Brief"), {
		name: "Brief.md",
		stat: { mtime: 0, size: 10 },
	});
	const active = {
		path: file.path,
		name: "Brief",
		modified: 0,
		created: 0,
		extension: "md",
		...opts.active,
	};
	const vaultAccess = {
		getActiveNote: async () => (opts.follow ? active : null),
		subscribeSelectionChanges: () => noop,
		getAllFiles: () => opts.files ?? [file],
		readNote: opts.read ?? (async () => "BODY"),
		searchNotes: vi.fn(async () => [active]),
	};
	const settings = {
		displaySettings: {
			maxNoteLength: 100,
			maxSelectionLength: 100,
			fontSize: null,
		},
		autoMentionActiveNote: !!opts.follow,
		presetAgents: {},
		sessionHistoryFilters: { currentVaultOnly: true, hideNonLocal: false },
		customAgents: [],
		savedSessions: [],
		exportSettings: {},
		promptInjection: {
			enabled: !!opts.inject,
			latex: true,
			tables: true,
			wikiLinks: true,
		},
	};
	const settingsService = {
		subscribe: () => noop,
		loadSessionMessages: async () => [],
		saveSessionMessages: noop,
		saveSession: noop,
		getSnapshot: () => settings,
		getSavedSessions: () => [{ sessionId: "A" }],
	};
	const events = new Map();
	let native;
	const vault = {
		adapter: new FileSystemAdapter(),
		getConfig: () => false,
		readBinary: opts.readBinary ?? noop,
	};
	const plugin = {
		app: {
			vault,
			workspace: {
				requestSaveLayout: noop,
				on: (e, fn) => {
					events.set(e, fn);
					return e;
				},
				offref: noop,
			},
			dragManager: {},
		},
		settings,
		settingsService,
		companionStorage: storage,
		viewRegistry: new ChatViewRegistry(),
		getAvailableAgents: () => [],
		registerCompanionSelection: (_, h) => {
			native = h;
			return noop;
		},
		checkForUpdates: async () => false,
		registerPendingPromptHandler: () => noop,
	};
	let enqueue: any, messagesAPI: any;
	m.agent = (client, settings, vault) => {
		const msg = useAgentMessages(
			client,
			settings,
			vault,
			session as never,
			noop,
		);
		enqueue = msg.enqueueUpdate;
		messagesAPI = msg;
		return {
			...msg,
			isReady: true,
			session,
			messages: msg.messages.length ? msg.messages : messages,
			createSession: create,
			closeSession: noop,
			cancelOperation: async () => msg.clearPendingUpdates(),
			restartSession: restart,
			forceRestartAgent: restart,
		};
	};
	let tree: any, inputTree: any;
	const context = {
		plugin,
		settingsService,
		acpClient: wire,
		vaultService: vaultAccess,
	};
	let tray: any;
	function ToolHarness({ props }) {
		tray = ContextTray(props);
		return null;
	}
	function Harness() {
		tree = ChatPanel.type({
			viewId: "view",
			variant: opts.variant ?? "sidebar",
			initialAgentId: "reviewer",
			workingDirectory: "/test",
		});
		if (opts.input)
			inputTree = InputArea(
				search(tree, (e) => e.type === InputArea).props,
			);
		const tool = opts.tools && search(tree, (e) => e.type === ContextTray);
		return tool ? createElement(ToolHarness, { props: tool.props }) : null;
	}
	const container = {
		nodeType: 1,
		tagName: "DIV",
		ownerDocument: doc,
		namespaceURI: "http://www.w3.org/1999/xhtml",
		addEventListener: noop,
	};
	root = createRoot(container as any);
	const render = () =>
		act(async () =>
			root.render(
				createElement(
					ChatContextProvider,
					{ value: context as never },
					createElement(Harness),
				),
			),
		);
	await render();
	return {
		get input() {
			return search(tree, (e) => e.type === InputArea).props;
		},
		get header() {
			return search(tree, (e) => e.type === ChatHeader).props;
		},
		get row() {
			return this.input.contextRow.props;
		},
		get output() {
			return tree;
		},
		get tray() {
			return tray;
		},
		get actualInput() {
			return inputTree;
		},
		get msg() {
			return messagesAPI;
		},
		get native() {
			return native();
		},
		chunk: (t) =>
			enqueue({ type: "agent_message_chunk", sessionId: "A", text: t }),
		failVerify: () => (verifyNext = true),
		session,
		readFail: () => (failed = true),
		storage,
		wire,
		prompt,
		create,
		restart,
		plugin,
		events,
		vaultAccess,
		render,
	};
}

const findBtn = (e, label) =>
	search(e, (x) => x.type === "button" && x.props.children === label)?.props;
const fakeFile = (path, size = 10) =>
	Object.assign(new TFile(path, path.split(".")[0]), {
		name: path,
		stat: { mtime: 0, size },
	});

it("X9 transport-rejected fork retains the actual reply and its pending reviewed-change affordance", async () => {
	const h = await mount({ tools: true });
	await act(async () =>
		h.native.stage(
			{ path: "Brief.md", text: "BODY", capturedAt: 1 },
			{ start: 0, end: 4 },
			"ask",
			noop,
		),
	);
	const target = h.row.chips[0].itemId;
	await act(async () => h.row.onTools());
	m.confirm.mockResolvedValueOnce(true);
	h.prompt.mockImplementationOnce(async (_, blocks) => {
		const id = /"requestId":"([a-z0-9-]+)"/.exec(
			blocks
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join(" "),
		)![1];
		h.chunk(
			JSON.stringify({
				requestId: id,
				result: [
					{
						itemId: target,
						original: "BODY",
						replacement: "Reviewed",
					},
				],
			}),
		);
	});
	await act(async () => findBtn(h.tray, "Review passages").onClick());
	const list = () => search(h.output, (e) => e.type === MessageList).props,
		reply = list().messages.find((m) => m.role === "assistant"),
		acts = () => list().renderReplyActions(reply).props;
	expect(acts().proposals).toHaveLength(1);
	const version = h.msg.transcriptVersion;
	await act(async () => h.header.onOpenHistory());
	const enter = latch(),
		release = latch();
	h.wire.forkSession = vi.fn(async () => {
		enter.go();
		await release.p;
		throw Error("fork rejected");
	});
	let fork;
	await act(async () => {
		fork = m.history.onForkSession("A", "/test");
		await enter.p;
	});
	await act(async () => h.input.onSendMessage("must not send while forking"));
	release.go();
	await act(async () => fork);
	expect(h.prompt).toHaveBeenCalledTimes(1);
	expect(h.msg.transcriptVersion).toBe(version);
	expect(list().messages.some((m) => m.id === reply.id)).toBe(true);
	const obs = {
		pending: acts().proposals.length,
		insert: acts().insertLabel,
		owner: h.session.sessionId,
	};
	console.log("X9", obs);
	expect(obs.pending).toBe(1);
});
