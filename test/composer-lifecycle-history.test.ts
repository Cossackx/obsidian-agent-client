import { ContextTray } from "../src/ui/ContextTray";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	createElement,
	act,
	type MemoExoticComponent,
	type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatContextProvider } from "../src/ui/ChatContext";
import { ChatPanel, type ChatPanelProps } from "../src/ui/ChatPanel";
import {
	useAgentMessages,
	type UseAgentMessagesReturn,
} from "../src/hooks/useAgentMessages";
import type { useAgent } from "../src/hooks/useAgent";
import { CompanionStorage } from "../src/services/companion-storage";
import { ChatViewRegistry } from "../src/services/view-registry";
import { InputArea } from "../src/ui/InputArea";
import { ChatHeader, type SidebarHeaderProps } from "../src/ui/ChatHeader";
import { MessageList } from "../src/ui/MessageList";
import { ComposerContext } from "../src/ui/ComposerContext";
import { ReplyNoteActions } from "../src/ui/ReplyNoteActions";
import { TFile, FileSystemAdapter } from "obsidian";
import type { ChatMessage, PromptContent } from "../src/types/chat";
import type { SelectionOwner } from "../src/services/editor-selection-action";
import type { SessionHistoryModalProps } from "../src/ui/SessionHistoryModal";
import {
	find,
	findBtn,
	latch,
	propsOf,
	type MenuRow,
} from "./composer-lifecycle-helpers";
const m = vi.hoisted(() => ({
	notice: vi.fn<(message: string) => void>(),
	confirm: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
	agent: undefined as
		| ((...args: Parameters<typeof useAgent>) => unknown)
		| undefined,
	picker: vi.fn<(...args: unknown[]) => unknown>(),
	menu: [] as MenuRow[],
	history: undefined as SessionHistoryModalProps | undefined,
}));
vi.mock("obsidian", async (orig) => ({
	...(await orig<object>()),
	Modal: class {},
	MarkdownView: class {},
	FuzzySuggestModal: class {},
	FileSystemAdapter: class {
		getFullPath(p: string) {
			return "/test/" + p;
		}
	},
	arrayBufferToBase64: () => "AA==",
	Menu: class {
		addItem(fn: (row: MenuRow) => void) {
			const row: MenuRow = {
				setTitle(this: MenuRow, s: string) {
					this.title = s;
					return this;
				},
				onClick(this: MenuRow, f: () => void) {
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
		constructor(s: string) {
			m.notice(s);
		}
	},
}));
vi.mock("../src/hooks/useAgent", () => ({
	useAgent: (...args: Parameters<typeof useAgent>) => m.agent!(...args),
}));
vi.mock("../src/ui/SessionHistoryModal", () => ({
	SessionHistoryModal: class {
		constructor(_app: unknown, props: SessionHistoryModalProps) {
			m.history = props;
		}
		open() {}
		updateProps(props: SessionHistoryModalProps) {
			m.history = props;
		}
	},
}));
vi.mock("../src/hooks/useSettings", () => ({
	useSettingsSelector: (
		p: { settings: unknown },
		sel: (settings: unknown) => unknown,
	) => sel(p.settings),
	useSettings: (p: { settings: unknown }) => p.settings,
}));
vi.mock("../src/ui/ContextPreviewModal", () => ({
	confirmPayload: (...a: unknown[]) => m.confirm(...a),
}));
vi.mock("../src/ui/ReplyTargetPicker", () => ({
	chooseReplyTarget: (...a: unknown[]) => m.picker(...a),
}));
vi.mock("../src/ui/MessageList", () => ({ MessageList: () => null }));
const noop = () => {};
const doc = { nodeType: 9, addEventListener: noop, activeElement: null };
let root: Root | null = null;
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
	const mounted = root;
	if (mounted) await act(async () => mounted.unmount());
	root = null;
	vi.unstubAllGlobals();
});

type Capture = (allowCaret?: boolean) => Promise<unknown>;
interface FakeVaultAccess {
	getActiveNote: () => Promise<Record<string, unknown> | null>;
	subscribeSelectionChanges: () => () => void;
	getAllFiles: () => TFile[];
	readNote: (path: string) => Promise<string | undefined>;
	searchNotes: ReturnType<typeof vi.fn<(query: string) => Promise<object[]>>>;
	captureActiveSelection?: Capture;
}
interface MountOptions {
	embedded?: boolean;
	messages?: ChatMessage[];
	active?: Record<string, unknown>;
	follow?: boolean;
	files?: TFile[];
	read?: (path: string) => Promise<string>;
	inject?: boolean;
	readBinary?: () => unknown;
	tools?: boolean;
	receipt?: boolean;
	input?: boolean;
	variant?: "sidebar" | "floating";
}
type TrayProps = Parameters<typeof ContextTray>[0];

async function mount(opts: MountOptions = {}) {
	const files = new Map<string, string>();
	let failed = false,
		verifyNext = false,
		failVerify = false;
	const adapter = {
		exists: async (p: string) => p === "side" || files.has(p),
		read: async (p: string) => {
			if (failVerify) {
				failVerify = false;
				throw Error("transient verification error");
			}
			return files.get(p);
		},
		mkdir: noop,
		write: async (p: string, t: string) => {
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
	const prompt = vi.fn(async (_id: string, _blocks: PromptContent[]) => {}),
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
	const wire: {
		hasLiveSession: () => boolean;
		sendPrompt: typeof prompt;
		forkSession?: () => Promise<unknown>;
	} = { hasLiveSession: () => true, sendPrompt: prompt };
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
	const vaultAccess: FakeVaultAccess = {
		getActiveNote: async () => (opts.follow ? active : null),
		subscribeSelectionChanges: () => noop,
		getAllFiles: () => opts.files ?? [file],
		readNote: opts.read ?? (async () => "BODY"),
		searchNotes: vi.fn(
			async (_query: string): Promise<object[]> => [active],
		),
	};
	const settings = {
		displaySettings: {
			maxNoteLength: 100,
			maxSelectionLength: 100,
			fontSize: null,
		},
		autoMentionActiveNote: !!opts.follow,
		voice: { enabled: false },
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
	const events = new Map<string, unknown>();
	let native: (() => SelectionOwner | undefined) | undefined;
	const vault = {
		adapter: new FileSystemAdapter(),
		getConfig: () => false,
		readBinary: opts.readBinary ?? noop,
	};
	const VOICE_OFF = { state: "off" }; // stable snapshot for useSyncExternalStore
	const plugin = {
		app: {
			vault,
			workspace: {
				requestSaveLayout: noop,
				on: (e: string, fn: unknown) => {
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
		registerCompanionSelection: (
			_: string,
			h: () => SelectionOwner | undefined,
		) => {
			native = h;
			return noop;
		},
		checkForUpdates: async () => false,
		registerPendingPromptHandler: () => noop,
		// Voice off: the composer renders without starting the helper.
		voiceHelper: { subscribe: () => noop, getStatus: () => VOICE_OFF },
	};
	let enqueue: UseAgentMessagesReturn["enqueueUpdate"] | undefined,
		messagesAPI: UseAgentMessagesReturn | undefined;
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
	let tree: ReactNode, inputTree: ReactNode;
	const context = {
		plugin,
		settingsService,
		acpClient: wire,
		vaultService: vaultAccess,
	};
	let tray: ReactNode;
	function ToolHarness({ props }: { props: TrayProps }) {
		tray = ContextTray(props);
		return null;
	}
	function Harness() {
		tree = (
			ChatPanel as MemoExoticComponent<
				(props: ChatPanelProps) => ReactNode
			>
		).type({
			viewId: "view",
			variant: opts.variant ?? "sidebar",
			initialAgentId: "reviewer",
			workingDirectory: "/test",
		});
		if (opts.input) inputTree = InputArea(propsOf(tree, InputArea));
		const tool = opts.tools && find(tree, ContextTray);
		return tool ? createElement(ToolHarness, { props: tool.props }) : null;
	}
	const container = {
		nodeType: 1,
		tagName: "DIV",
		ownerDocument: doc,
		namespaceURI: "http://www.w3.org/1999/xhtml",
		addEventListener: noop,
	};
	const created = createRoot(container as never);
	root = created;
	const render = () =>
		act(async () =>
			created.render(
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
			return propsOf(tree, InputArea);
		},
		get header() {
			return propsOf(tree, ChatHeader);
		},
		get row() {
			return propsOf(
				propsOf(tree, InputArea).contextRow,
				ComposerContext,
			);
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
			return messagesAPI!;
		},
		get native() {
			return native!()!;
		},
		chunk: (t: string) =>
			enqueue!({ type: "agent_message_chunk", sessionId: "A", text: t }),
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
				.flatMap((b) => (b.type === "text" ? [b.text] : []))
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
	await act(async () => findBtn(h.tray, "Review passages")!.onClick());
	const list = () => propsOf(h.output, MessageList),
		reply = list().messages.find((m) => m.role === "assistant")!,
		acts = () =>
			propsOf(list().renderReplyActions!(reply), ReplyNoteActions);
	expect(acts().proposals).toHaveLength(1);
	const version = h.msg.transcriptVersion;
	await act(async () => (h.header as SidebarHeaderProps).onOpenHistory!());
	const enter = latch(),
		release = latch();
	h.wire.forkSession = vi.fn(async () => {
		enter.go();
		await release.p;
		throw Error("fork rejected");
	});
	let fork: Promise<void> | undefined;
	await act(async () => {
		fork = m.history!.onForkSession("A", "/test");
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
	expect(obs.pending).toBe(1);
});
