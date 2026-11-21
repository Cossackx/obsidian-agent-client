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
import { InputArea, type InputAreaProps } from "../src/ui/InputArea";
import { ChatHeader, type FloatingHeaderProps } from "../src/ui/ChatHeader";
import { MessageList } from "../src/ui/MessageList";
import { ComposerContext } from "../src/ui/ComposerContext";
import { ReplyNoteActions } from "../src/ui/ReplyNoteActions";
import { TFile, FileSystemAdapter } from "obsidian";
import type { ChatMessage, PromptContent } from "../src/types/chat";
import type { ContextItem } from "../src/types/note-companion";
import type { SelectionOwner } from "../src/services/editor-selection-action";
import {
	fakeFile,
	find,
	findBtn,
	latch,
	propsOf,
	search,
	type MenuRow,
	type TreeElement,
} from "./composer-lifecycle-helpers";
type ModalButton = { onclick?: () => void; disabled?: boolean };
type ModalElement = ModalButton & {
	createEl: (tag: string, options?: { text?: string }) => ModalElement;
	createDiv: () => ModalElement;
	querySelector: () => null;
	addClass: () => void;
	setText: () => void;
	focus: () => void;
};
type Dialog = { title: string; buttons: Map<string, ModalButton> };
const m = vi.hoisted(() => ({
	notice: vi.fn<(message: string) => void>(),
	confirm: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
	agent: undefined as
		| ((...args: Parameters<typeof useAgent>) => unknown)
		| undefined,
	picker: vi.fn<(...args: unknown[]) => unknown>(),
	menu: [] as MenuRow[],
	dialog: undefined as Dialog | undefined,
}));
vi.mock("obsidian", async (orig) => ({
	...(await orig<object>()),
	// DOM boundary only: the production modals create and handle their buttons.
	Modal: class implements Dialog {
		title = "";
		buttons = new Map<string, ModalButton>();
		contentEl = this.element();
		private element(): ModalElement {
			return {
				createEl: (tag: string, options?: { text?: string }) => {
					const el = this.element();
					if (tag === "button" && options?.text)
						this.buttons.set(options.text, el);
					return el;
				},
				createDiv: () => this.element(),
				querySelector: () => null,
				addClass: () => {},
				setText: () => {},
				focus: () => {},
			};
		}
		setTitle(title: string) {
			this.title = title;
		}
		onOpen() {}
		onClose() {}
		open() {
			m.dialog = this;
			this.onOpen();
		}
		close() {
			m.dialog = undefined;
			this.onClose();
		}
	},
	Plugin: class {},
	PluginSettingTab: class {},
	ItemView: class {},
	MarkdownRenderChild: class {},
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
vi.mock("../src/hooks/useSessionHistory", () => ({
	useSessionHistory: () => ({
		loading: false,
		saveSessionMessages: () => {},
		invalidateCache: () => {},
	}),
}));
vi.mock("../src/hooks/useHistoryModal", () => ({
	useHistoryModal: () => ({ handleOpenHistory: () => {} }),
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
	m.dialog = undefined;
});
afterEach(async () => {
	const mounted = root;
	if (mounted) await act(async () => mounted.unmount());
	root = null;
	vi.unstubAllGlobals();
});

type Capture = VaultService["captureActiveSelection"];
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
	restoredItems?: ContextItem[];
}
type TrayProps = Parameters<typeof ContextTray>[0];

async function mount(opts: MountOptions = {}) {
	const files = new Map<string, string>();
	let failed = false,
		verifyNext = 0,
		failVerify = 0;
	const adapter = {
		exists: async (p: string) => p === "side" || files.has(p),
		read: vi.fn(async (p: string) => {
			if (failVerify) {
				failVerify--;
				throw Error("transient verification error");
			}
			const text = files.get(p);
			if (text === undefined) throw Error(`Missing sidecar ${p}`);
			return text;
		}),
		mkdir: async () => {},
		remove: async (p: string) => {
			files.delete(p);
		},
		write: vi.fn(async (p: string, t: string) => {
			if (failed) {
				failed = false;
				throw Error("test persistence failure");
			}
			files.set(p, t);
			if (verifyNext) {
				failVerify = verifyNext;
				verifyNext = 0;
			}
		}),
		list: async () => ({ files: [...files.keys()], folders: [] }),
	};
	const storage = new CompanionStorage(adapter, "side");
	const restoredItems = opts.restoredItems;
	if (restoredItems)
		await storage.update("A", (s) => ({ ...s, items: restoredItems }));
	const prompt = vi.fn(async (_id: string, _blocks: PromptContent[]) => {}),
		create = vi.fn(),
		restart = vi.fn(),
		session = {
			state: "ready",
			sessionId: "A",
			agentId: "reviewer",
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
		presetAgents: {},
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
	let detail: ReactNode;
	function DetailHarness({ node }: { node: TreeElement }) {
		// ReceiptDetails is module-private; render its element in place.
		detail = (node.type as (props: object) => ReactNode)(node.props);
		return null;
	}
	function ToolHarness({ props }: { props: TrayProps }) {
		tray = ContextTray(props);
		const node =
			opts.receipt &&
			search(
				tray,
				(e) =>
					typeof e.type === "function" &&
					e.type.name === "ReceiptDetails",
			);
		return node ? createElement(DetailHarness, { node }) : null;
	}
	function InputHarness({ props }: { props: InputAreaProps }) {
		inputTree = InputArea(props);
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
		const tool = opts.tools && find(tree, ContextTray);
		const inputElement = find(tree, InputArea)!;
		return [
			opts.input
				? createElement(InputHarness, {
						key: inputElement.key,
						props: inputElement.props,
					})
				: null,
			tool
				? createElement(ToolHarness, {
						key: tool.key,
						props: tool.props,
					})
				: null,
		];
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
		get detail() {
			return detail;
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
		failVerify: (count = 1) => (verifyNext = count),
		session,
		readFail: () => (failed = true),
		adapter,
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
type Mounted = Awaited<ReturnType<typeof mount>>;
const load = async (h: Mounted, id = "A") => (await h.storage.load(id))!;

const sel = {
	range: { start: 0, end: 4 },
	from: { line: 0, ch: 0 },
	to: { line: 0, ch: 4 },
	text: "BODY",
};
async function follow(opts: MountOptions = {}) {
	const h = await mount({
		follow: true,
		active: { selection: sel },
		...opts,
	});
	h.vaultAccess.captureActiveSelection = async () => ({
		path: "Brief.md",
		text: "BODY",
		range: sel.range,
		stillTarget: () => true,
		capturedAt: 1,
	});
	return h;
}

import AgentClientPlugin from "../src/plugin";
import { stageEditorSelection } from "../src/services/editor-selection-action";
import { VaultService } from "../src/services/vault-service";
import { MarkdownView } from "obsidian";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { NoteActionService } from "../src/services/note-action-service";
function attachVault(
	h: Mounted,
	original = fakeFile("Brief.md"),
	text = "BODY",
) {
	const other = fakeFile(original.path),
		data = new Map<TFile, string>([
			[original, text],
			[other, text],
		]);
	let present = original;
	const v = Object.assign(h.plugin.app.vault, {
		getAbstractFileByPath: (p: string) =>
			p === "Brief.md" ? present : null,
		read: async (f: TFile) => data.get(f),
		process: vi.fn(async (f: TFile, fn: (data: string) => string) => {
			data.set(f, fn(data.get(f)!));
			return data.get(f);
		}),
	});
	const plugin = Object.assign(h.plugin, {
		noteActions: new NoteActionService(v as never, h.storage),
	});
	h.vaultAccess.readNote = async () => data.get(present);
	Object.assign(h.plugin.app.workspace, { getLeavesOfType: () => [] });
	// Copy the real (private) preimage methods onto the fixture plugin.
	const { editorsMatchPreimage, bindSelectionPreimage } =
		Object.getOwnPropertyDescriptors(AgentClientPlugin.prototype);
	Object.defineProperties(h.plugin, {
		editorsMatchPreimage,
		bindSelectionPreimage,
	});
	return {
		original,
		other,
		data,
		swap: () => {
			present = other;
		},
		v,
		plugin,
	};
}
function approveAndRespond(h: Mounted, result: unknown) {
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
				result,
			}),
		);
	});
}
function wireRevision(h: Mounted, itemId: string) {
	approveAndRespond(h, [{ itemId, original: "BODY", replacement: "EDIT" }]);
}
function proposalActions(h: Mounted) {
	const list = propsOf(h.output, MessageList);
	const reply = list.messages.find((m) => m.role === "assistant");
	return (
		reply && find(list.renderReplyActions!(reply), ReplyNoteActions)?.props
	);
}
it.each(["stable", "swap"])(
	"X1 Review passages generated diff: %s target at Accept",
	async (mode) => {
		const h = await mount({ tools: true }),
			a = attachVault(h);
		await act(async () =>
			h.native.stage(
				{ path: "Brief.md", text: "BODY", capturedAt: 1 },
				sel.range,
				"ask",
				noop,
				// Fixture input (XO-adjudicated): the TFile a real native stage captures.
				a.original,
			),
		);
		expect(h.prompt).not.toHaveBeenCalled();
		wireRevision(h, h.row.chips[0].itemId);
		await act(async () => h.row.onTools());
		await act(async () => findBtn(h.tray, "Review passages")!.onClick());
		const actions = proposalActions(h)!;
		expect(actions.proposals).toHaveLength(1);
		expect(a.v.process).not.toHaveBeenCalled();
		if (mode === "swap") a.swap();
		await act(async () => actions.onAccept(actions.proposals[0].proposal));
		expect(a.data.get(a.other)).toBe("BODY");
		expect(a.data.get(a.original)).toBe(mode === "swap" ? "BODY" : "EDIT");
	},
);
it.each(["after-stage", "during-atomic"])(
	"X2 Native Suggest edit: swap %s",
	async (mode) => {
		const h = await mount(),
			a = attachVault(h);
		await act(async () =>
			stageEditorSelection(
				{
					getValue: () => "BODY",
					getCursor: (k) => (k === "from" ? sel.from : sel.to),
				},
				"Brief.md",
				"suggest-edit",
				async () => h.native,
				() => a.v.getAbstractFileByPath("Brief.md") === a.original,
				undefined,
				// Fixture input: the view.file stageNativeSelection passes.
				a.original,
			),
		);
		expect(h.prompt).not.toHaveBeenCalled();
		if (mode === "after-stage") a.swap();
		wireRevision(h, h.row.chips[0].itemId);
		await act(async () => h.input.onSendMessage(h.input.inputValue));
		const actions = proposalActions(h);
		if (mode === "during-atomic") {
			expect(actions!.proposals).toHaveLength(1);
			a.v.process.mockImplementationOnce(async (f, fn) => {
				a.swap();
				a.data.set(f, fn(a.data.get(f)!));
				return undefined;
			});
		}
		if (actions?.proposals.length)
			await act(async () =>
				actions.onAccept(actions.proposals[0].proposal),
			);
		expect([...a.data.values()]).toEqual(["BODY", "BODY"]);
	},
);
it.each([
	"unchanged",
	"edit text",
	"move range",
	"replace file",
	"unwitnessed",
])("X3 final dispatch uses the actual editor capture: %s", async (mode) => {
	const enter = latch(),
		release = latch(),
		f = fakeFile("Brief.md"),
		g = fakeFile("Other.md");
	let buffer = "BODY TAIL",
		pos = 0;
	const h = await mount({
		follow: true,
		// Fixture input: the displayed selection carries its live file (non-enumerable).
		active: {
			selection:
				mode === "unwitnessed"
					? { ...sel }
					: Object.defineProperty({ ...sel }, "file", {
							value: f,
						}),
		},
		files: [f, g],
		read: async (p) => {
			if (p === "Other.md") {
				enter.go();
				await release.p;
				return "OTHER";
			}
			return buffer;
		},
	});
	const view = Object.assign(new MarkdownView({} as never), {
		file: f,
		getMode: () => "source",
		editor: {
			listSelections: () => [
				{
					anchor: { line: 0, ch: pos },
					head: { line: 0, ch: pos + 4 },
				},
			],
			getValue: () => buffer,
		},
	});
	Object.assign(h.plugin.app.workspace, {
		getActiveViewOfType: () => view,
		getActiveFile: () => view.file,
		getLeavesOfType: () => [{ view }],
	});
	Object.assign(h.plugin.app.vault, {
		getAbstractFileByPath: () => view.file,
	});
	// Real capture method over the fixture plugin (VaultService only reads this.plugin).
	const service = Object.create(VaultService.prototype, {
		plugin: { value: h.plugin },
	}) as VaultService;
	const capture = (allowCaret?: boolean) =>
		service.captureActiveSelection(allowCaret);
	h.vaultAccess.captureActiveSelection = capture;
	let send: Promise<unknown> | undefined;
	await act(async () => {
		send = h.input.onSendMessage("see @[[Other]]");
		await enter.p;
	});
	if (mode === "edit text") buffer = "SAFE TAIL";
	if (mode === "move range") pos = 5;
	// Same path and bytes, different file object during the first async read.
	if (mode === "replace file") view.file = fakeFile("Brief.md");
	const now = (await capture(true))!;
	release.go();
	await act(async () => send);
	const observed = {
		actual: now.text.slice(now.range.start, now.range.end),
		oldInWire: JSON.stringify(h.prompt.mock.calls).includes("BODY"),
		reviews: m.confirm.mock.calls.length,
	};
	expect(observed.oldInWire).toBe(mode === "unchanged");
	if (mode === "unchanged") expect(observed.reviews).toBe(0);
	if (mode === "replace file" || mode === "unwitnessed")
		expect(observed.reviews).toBe(1);
});
it("X4 retry does not restage removed newer capture", async () => {
	let text = "FIRST";
	const h = await mount({ read: async () => text });
	h.readFail();
	await act(async () => h.input.onStageNotes(["Brief.md"]));
	text = "SECOND";
	await act(async () => h.input.onStageNotes(["Brief.md"]));
	expect((await load(h)).items[0].source.text).toBe("SECOND");
	await act(async () => h.row.onRemove(h.row.chips[0]));
	expect((await load(h)).items).toEqual([]);
	await act(async () =>
		findBtn(h.output, "Retry local save or load")!.onClick(),
	);
	const items = (await load(h)).items.map((i) => i.source.text);
	expect(items).toEqual([]);
});
it("X5 pending @ lookup stays retired across owner switch", async () => {
	const h = await mount({ input: true, variant: "floating" }),
		enter = latch(),
		release = latch();
	await act(async () => h.storage.update("B", (s) => ({ ...s, draft: "@" })));
	h.vaultAccess.searchNotes.mockImplementationOnce(async () => {
		enter.go();
		await release.p;
		return [{ path: "Old.md", name: "Old" }];
	});
	await act(async () => h.row.onAdd({ nativeEvent: {} } as never));
	await act(async () => {
		m.menu.find((x) => x.title === "Add note…")!.click!();
		await enter.p;
	});
	h.restart.mockImplementationOnce(async () => {
		h.session.sessionId = "B";
	});
	await act(async () =>
		(h.header as FloatingHeaderProps).onAgentChange("other"),
	);
	await h.render();
	release.go();
	await act(async () => {});
	expect([
		h.input.inputValue,
		h.input.suggestions.mentions.isOpen,
		h.prompt.mock.calls.length,
	]).toEqual(["@", false, 0]);
});

import { planLiteralEdit } from "../src/services/note-edit-planner";
it("X10 restored Undo directs manual recovery; exact preimage and after-image are inspectable", async () => {
	const msg: ChatMessage = {
		id: "reply-10",
		role: "assistant",
		content: [{ type: "text", text: "Replacement" }],
		timestamp: new Date(),
	};
	const h = await mount({ messages: [msg], tools: true, receipt: true }),
		a = attachVault(h);
	const before = "alpha\r\nUNCHANGED CONTEXT\r\nTAIL";
	a.data.set(a.original, before);
	const p = planLiteralEdit(
		{ path: "Brief.md", text: before, capturedAt: 1 },
		{ kind: "range", path: "Brief.md", range: { start: 0, end: 5 } },
		"BETA",
		"replace",
		msg.id,
	);
	await act(async () => a.plugin.noteActions.apply("A", p));
	a.plugin.noteActions = new NoteActionService(
		{ ...a.v } as never,
		h.storage,
	);
	const acts = propsOf(
		propsOf(h.output, MessageList).renderReplyActions!(msg),
		ReplyNoteActions,
	);
	expect(acts.proposals.length).toBe(0);
	await act(async () => acts.onUndo(p.id));
	expect(m.notice.mock.calls.flat().join(" ")).toContain("manual recovery");
	expect(a.v.process).toHaveBeenCalledTimes(1);
	await act(async () => h.row.onTools());
	const details = search(h.detail, (e) => e.type === "details")!.props;
	await act(async () =>
		(details.onToggle as (event: unknown) => void)({
			currentTarget: { open: true },
		}),
	);
	const shown = search(h.detail, (e) => e.type === "pre")!.props.children;
	expect(shown).toContain("UNCHANGED CONTEXT");
});
it.each([2, 3])(
	"X11 durable remove with %i verification/independent/load read errors never sends removed material",
	async (failures) => {
		const h = await follow({ tools: true });
		await act(async () => h.row.onTogglePin(h.row.chips[0]));
		await act(async () => h.row.onTools());
		h.failVerify(failures);
		await act(async () => findBtn(h.tray, "Remove")!.onClick());
		const pending = !!findBtn(h.output, "Retry local save or load");
		expect(pending).toBe(true);
		m.confirm.mockResolvedValueOnce(true);
		await act(async () => h.input.onSendMessage("ordinary-only"));
		expect(h.prompt.mock.calls.length).toBe(failures === 2 ? 1 : 0);
		expect(
			JSON.stringify(m.confirm.mock.calls.map((args) => args[1])),
		).not.toContain("BODY");
		const s = await load(h);
		expect(s.followDismissed).toBe(true);
		expect(JSON.stringify(h.prompt.mock.calls)).not.toContain("BODY");
	},
);
it.each([false, true])(
	"X12 retry retains deliberately repeated passage independent of matching range: changedRange=%s",
	async (changedRange) => {
		const h = await mount({ tools: true });
		let range = { start: 0, end: 4 };
		h.vaultAccess.captureActiveSelection = async () => ({
			path: "Brief.md",
			text: "BODY TAIL",
			range,
			capturedAt: Date.now(),
		});
		await act(async () => h.row.onTools());
		const add = async () =>
			act(async () => findBtn(h.tray, "Add selection")!.onClick());
		await add();
		const first = (await load(h)).items[0];
		await act(async () =>
			h.storage.update("A", (s) => ({
				...s,
				items: s.items.map((i) => ({
					...i,
					annotation: "check claim",
				})),
			})),
		);
		if (changedRange) range = { start: 5, end: 9 };
		h.readFail();
		await add();
		expect(findBtn(h.output, "Retry local save or load")).toBeDefined();
		await act(async () =>
			findBtn(h.output, "Retry local save or load")!.onClick(),
		);
		const rows = (await load(h)).items;
		expect(rows[0].id).toBe(first.id);
		expect(rows).toHaveLength(2);
	},
);

it("X14 positive control: independently added passages can share a range but have separate annotations", async () => {
	const h = await mount({ tools: true });
	h.vaultAccess.captureActiveSelection = async () => ({
		path: "Brief.md",
		text: "BODY TAIL",
		range: { start: 0, end: 4 },
		capturedAt: 1,
	});
	await act(async () => h.row.onTools());
	for (let n = 0; n < 2; n++)
		await act(async () => findBtn(h.tray, "Add selection")!.onClick());
	const items = (await load(h)).items;
	expect(items).toHaveLength(2);
	expect(items[0].id).not.toBe(items[1].id);
});

const literalReply: ChatMessage = {
	id: "source-reply",
	role: "assistant",
	content: [{ type: "text", text: "Replacement" }],
	timestamp: new Date(),
};

function openSourceEditor(
	h: Mounted,
	a: ReturnType<typeof attachVault>,
	selection: Pick<typeof sel, "from" | "to"> = sel,
) {
	const view = Object.assign(
		Object.create(MarkdownView.prototype) as object,
		{
			file: a.original,
			getMode: () => "source",
			editor: {
				getValue: () => a.data.get(a.original)!,
				listSelections: () => [
					{ anchor: selection.from, head: selection.to },
				],
			},
		},
	);
	Object.assign(h.plugin.app.workspace, {
		getActiveFile: () => view.file,
		getActiveViewOfType: () => view,
		getLeavesOfType: () => [{ view }],
	});
	// Real capture reads this editor and retains its original TFile.
	const service = Object.create(VaultService.prototype, {
		plugin: { value: h.plugin },
	}) as VaultService;
	h.vaultAccess.captureActiveSelection = (allowCaret) =>
		service.captureActiveSelection(allowCaret);
	return view;
}

async function clickTray(h: Mounted, label: string) {
	const button = findBtn(h.tray, label);
	expect(button, label).toBeDefined();
	expect(button?.disabled, label).not.toBe(true);
	await act(async () => button!.onClick());
}

async function clickDialog(label: string) {
	const button = m.dialog?.buttons.get(label);
	expect(button?.onclick, `${m.dialog?.title}: ${label}`).toBeTypeOf(
		"function",
	);
	expect(button?.disabled, label).not.toBe(true);
	await act(async () => button!.onclick!());
}

async function acceptOfferedEdit(h: Mounted) {
	const actions = proposalActions(h);
	expect(actions?.proposals).toHaveLength(1);
	await act(async () => actions!.onAccept(actions!.proposals[0].proposal));
}

it.each(["stable", "before note choice", "during heading choice"])(
	"F1 section editorial retains the offered file: %s",
	async (mode) => {
		const before = "# Plan\nBODY\n";
		const h = await mount({ tools: true, messages: [literalReply] });
		const a = attachVault(h, fakeFile("Brief.md"), before);
		openSourceEditor(h, a);
		await act(async () => h.row.onTools());
		await clickTray(h, "Choose destination");
		expect(m.dialog?.title).toBe("Pick a destination note");
		if (mode === "before note choice") a.swap();
		await clickDialog("Brief.md");
		if (mode !== "before note choice" || m.dialog) {
			expect(m.dialog?.title).toBe("Placement in Brief.md");
			if (mode === "during heading choice") a.swap();
			await clickDialog("Plan · 1");
		}
		approveAndRespond(h, { path: "Brief.md", markdown: "EDIT" });
		await clickTray(h, "Merge into section");
		expect(a.v.process).not.toHaveBeenCalled();
		// Accept an offered diff even in the swap cases: the old path offers one.
		if (mode === "stable" || proposalActions(h)?.proposals.length)
			await acceptOfferedEdit(h);
		expect(a.data.get(a.other)).toBe(before);
		expect(a.data.get(a.original)).toBe(
			mode === "stable" ? "# Plan\nEDIT\n" : before,
		);
		if (mode === "stable") {
			expect(m.confirm).toHaveBeenCalledTimes(1);
			expect(a.v.process).toHaveBeenCalledExactlyOnceWith(
				a.original,
				expect.any(Function),
			);
			expect((await load(h)).operations[0]?.receipt.status).toBe(
				"verified",
			);
		} else {
			expect(a.v.process).not.toHaveBeenCalled();
			expect(h.prompt).not.toHaveBeenCalled();
		}
	},
);

it.each([false, true])(
	"F2 literal preview writes only on Apply to the captured file: swap=%s",
	async (swap) => {
		const before = "Keep BODY here.\n";
		const h = await mount({ tools: true, messages: [literalReply] });
		const a = attachVault(h, fakeFile("Brief.md"), before);
		openSourceEditor(h, a, {
			from: { line: 0, ch: 5 },
			to: { line: 0, ch: 9 },
		});
		await act(async () => h.row.onTools());
		await clickTray(h, "Capture destination selection");
		await clickTray(h, "Replace · preview");
		expect(m.dialog?.title).toBe("Review note change");
		expect(a.v.process).not.toHaveBeenCalled();
		expect([...a.data.values()]).toEqual([before, before]);
		if (swap) a.swap();
		await clickDialog("Apply this change");
		expect(a.data.get(a.other)).toBe(before);
		expect(a.data.get(a.original)).toBe(
			swap ? before : "Keep Replacement here.\n",
		);
		if (swap) expect(a.v.process).not.toHaveBeenCalled();
		else {
			expect(a.v.process).toHaveBeenCalledExactlyOnceWith(
				a.original,
				expect.any(Function),
			);
			expect((await load(h)).operations[0]?.receipt.status).toBe(
				"verified",
			);
		}
	},
);

it.each(["live pin", "fileless registered stage", "restored"])(
	"F3 passage review requires its original file witness: %s",
	async (mode) => {
		const original = fakeFile("Brief.md");
		const path = original.path;
		const source = { path, text: "BODY", capturedAt: 1 };
		const livePin = mode === "live pin";
		const h = await mount({
			tools: true,
			follow: livePin,
			active: {
				selection: Object.defineProperty({ ...sel }, "file", {
					value: original,
				}),
			},
			restoredItems:
				mode === "restored"
					? [
							{
								id: "restored-passage",
								source,
								scope: { kind: "passage", range: sel.range },
								role: "working",
								lifetime: "session",
							},
						]
					: undefined,
		});
		const a = attachVault(h, original);
		openSourceEditor(h, a);
		if (livePin) {
			const capture = await h.vaultAccess.captureActiveSelection!();
			expect(capture?.file).toBe(original);
			expect(h.row.chips[0]?.kind).toBe("following");
			await act(async () => h.row.onTogglePin(h.row.chips[0]));
		} else if (mode === "fileless registered stage") {
			a.swap();
			// Exercise the registered boundary, not a fileless native editor event.
			await act(async () =>
				h.native.stage(source, sel.range, "suggest-edit", noop),
			);
		}
		const { items } = await load(h);
		expect(items).toHaveLength(1);
		expect(items[0].scope).toEqual({ kind: "passage", range: sel.range });
		expect(items[0].source).not.toHaveProperty("file");
		expect(h.prompt).not.toHaveBeenCalled();
		wireRevision(h, items[0].id);
		if (mode === "fileless registered stage") {
			await act(async () => h.input.onSendMessage(h.input.inputValue));
			// The guarded Send can refuse early. If it offers a diff, test Accept.
			if (proposalActions(h)?.proposals.length)
				await acceptOfferedEdit(h);
		} else {
			await act(async () => h.row.onTools());
			await clickTray(h, "Review passages");
			expect(h.prompt).toHaveBeenCalledTimes(1);
			expect(a.v.process).not.toHaveBeenCalled();
			await acceptOfferedEdit(h);
		}
		expect(a.data.get(a.other)).toBe("BODY");
		expect(a.data.get(original)).toBe(livePin ? "EDIT" : "BODY");
		if (livePin) {
			expect((await load(h)).operations[0]?.receipt.status).toBe(
				"verified",
			);
		} else expect(a.v.process).not.toHaveBeenCalled();
		if (mode === "fileless registered stage") {
			expect(h.input.inputValue).not.toBe("");
			expect(h.prompt).not.toHaveBeenCalled();
			expect(m.notice.mock.calls.flat().join(" ")).toContain(
				"no longer known",
			);
		}
	},
);

async function dropMarkdown(h: Mounted, path: string) {
	Object.assign(h.plugin.app.dragManager, {
		draggable: { type: "file", file: fakeFile(path) },
	});
	const dropTarget = search(
		h.actualInput,
		(e) => typeof e.props.onDrop === "function",
	);
	const preventDefault = vi.fn();
	const event = { dataTransfer: { files: [] }, preventDefault };
	// The rendered handler uses only these fields of the browser event.
	const onDrop = dropTarget?.props.onDrop as
		| ((e: typeof event) => void)
		| undefined;
	expect(onDrop).toBeTypeOf("function");
	await act(async () => onDrop!(event));
	expect(preventDefault).toHaveBeenCalledTimes(1);
}

it.each(["initial read error", "independent readback", "clean acknowledgment"])(
	"F5 retry never resurrects an older drop after successor removal: %s",
	async (mode) => {
		let text = "FIRST";
		const h = await mount({
			input: true,
			read: async (path) => (path === "Brief.md" ? text : "OTHER"),
		});
		if (mode === "initial read error") {
			// Open a real, empty sidecar on the first drop.
			await act(async () => h.storage.update("A", (s) => s));
			h.adapter.read.mockRejectedValueOnce(Error("opening sidecar"));
		} else h.readFail();
		h.adapter.write.mockClear();
		await dropMarkdown(h, "Brief.md");
		expect(findBtn(h.output, "Retry local save or load")).toBeDefined();
		expect(h.adapter.write).toHaveBeenCalledTimes(
			mode === "initial read error" ? 0 : 1,
		);
		expect((await h.storage.load("A"))?.items ?? []).toEqual([]);
		text = "SECOND";
		h.adapter.read.mockClear();
		h.adapter.write.mockClear();
		if (mode === "independent readback") h.failVerify();
		await dropMarkdown(h, "Brief.md");
		if (mode === "independent readback") {
			// Observe the production independent readback before the test performs any load.
			expect(h.adapter.write).toHaveBeenCalledTimes(1);
			const [target, raw] = h.adapter.write.mock.calls[0];
			const [verify, readback] = h.adapter.read.mock.results;
			expect(h.adapter.read.mock.calls).toEqual([[target], [target]]);
			await expect(verify.value).rejects.toThrow(
				"transient verification error",
			);
			await expect(readback.value).resolves.toBe(raw);
		}
		const second = (await load(h)).items;
		expect(second.map((item) => item.source.text)).toEqual(["SECOND"]);
		if (mode === "independent readback") await dropMarkdown(h, "Other.md");
		const chip = h.row.chips.find((row) => row.itemId === second[0].id);
		expect(chip?.path).toBe("Brief.md");
		await act(async () => h.row.onRemove(chip!));
		const expected =
			mode === "independent readback" ? [["Other.md", "OTHER"]] : [];
		const durable = async () =>
			(await load(h)).items.map(({ source }) => [
				source.path,
				source.text,
			]);
		expect(await durable()).toEqual(expected);
		const retry = findBtn(h.output, "Retry local save or load");
		expect(retry).toBeDefined();
		await act(async () => retry!.onClick());
		expect(await durable()).toEqual(expected);
		expect(findBtn(h.output, "Retry local save or load")).toBeUndefined();
	},
);

/** Open-leaf and reply-row identity comes from the choice event, not path lookup. */
async function chooseSectionDestination(h: Mounted) {
	await clickTray(h, "Choose destination");
	await clickDialog("Brief.md");
	await clickDialog("Plan · 1");
}

it("Z1 a stale open leaf is refused at choice, never rebound to the path occupant", async () => {
	const before = "# Plan\nBODY\n";
	const h = await mount({ tools: true, messages: [literalReply] });
	const a = attachVault(h, fakeFile("Brief.md"), before);
	openSourceEditor(h, a);
	await act(async () => h.row.onTools());
	a.swap(); // leaf still shows the original; the path now resolves to another file
	await clickTray(h, "Choose destination");
	await clickDialog("Brief.md");
	expect(m.dialog?.title).not.toBe("Placement in Brief.md");
	expect((await h.storage.load("A"))?.destination).toBeUndefined();
	expect(a.v.process).not.toHaveBeenCalled();
	expect([...a.data.values()]).toEqual([before, before]);
});

it.each([
	"stable",
	"swap after choice",
	"reopened tools",
	"restored destination",
])(
	"Z2 reply-row Append uses the destination choice witness: %s",
	async (mode) => {
		const before = "# Plan\nBODY\n";
		const h = await mount({ tools: true, messages: [literalReply] });
		const a = attachVault(h, fakeFile("Brief.md"), before);
		openSourceEditor(h, a);
		await act(async () => h.row.onTools());
		if (mode === "restored destination")
			await act(async () =>
				h.storage.update("A", (s) => ({
					...s,
					destination: {
						kind: "heading",
						path: "Brief.md",
						heading: "Plan",
						occurrence: 1,
					},
				})),
			);
		else await chooseSectionDestination(h);
		if (mode === "reopened tools") {
			await act(async () => h.row.onTools());
			await act(async () => h.row.onTools());
		}
		if (mode === "swap after choice") a.swap();
		const actions = proposalActions(h)!;
		expect(actions.insertLabel).toContain("Plan");
		await act(async () => actions.onInsert());
		expect(m.picker).not.toHaveBeenCalled();
		expect(a.data.get(a.other)).toBe(before);
		if (mode === "stable" || mode === "reopened tools") {
			expect(a.data.get(a.original)).toContain("Replacement");
			expect(a.v.process).toHaveBeenCalledExactlyOnceWith(
				a.original,
				expect.any(Function),
			);
		} else {
			expect(a.data.get(a.original)).toBe(before);
			expect(a.v.process).not.toHaveBeenCalled();
		}
	},
);

it("Z3 Pin refuses write authority when the displayed selection's file was replaced", async () => {
	const original = fakeFile("Brief.md");
	const h = await mount({
		tools: true,
		follow: true,
		active: {
			selection: Object.defineProperty({ ...sel }, "file", {
				value: original,
			}),
		},
	});
	const a = attachVault(h, original);
	const view = openSourceEditor(h, a);
	// An identical replacement is now in the editor; recapture sees it, not the shown file.
	a.swap();
	view.file = a.other;
	await act(async () => h.row.onTogglePin(h.row.chips[0]));
	const items = (await h.storage.load("A"))?.items ?? [];
	if (items.length) {
		wireRevision(h, items[0].id);
		await act(async () => h.row.onTools());
		await clickTray(h, "Review passages");
		if (proposalActions(h)?.proposals.length) await acceptOfferedEdit(h);
	}
	expect(a.v.process).not.toHaveBeenCalled();
	expect([...a.data.values()]).toEqual(["BODY", "BODY"]);
});

it.each(["stable", "refresh after swap"])(
	"Z4 tracked selection keeps its editor file through metadata refresh: %s",
	async (mode) => {
		const h = await mount({ follow: true });
		const a = attachVault(h);
		const view = openSourceEditor(h, a);
		Object.assign(view.editor, {
			somethingSelected: () => true,
			hasFocus: () => false,
		});
		Object.assign(a.v, {
			on: () => ({}),
			getMarkdownFiles: () => [a.original],
		});
		Object.assign(h.plugin.app, {
			metadataCache: { getFileCache: () => ({}) },
		});
		// Real tracker; the fixture plugin is the same shape the harness passes elsewhere.
		const svc = new VaultService(h.plugin as never);
		Object.assign(h.vaultAccess, {
			getActiveNote: () => svc.getActiveNote(),
			captureActiveSelection: (caret?: boolean) =>
				svc.captureActiveSelection(caret),
		});
		const refresh = () => h.input.suggestions.mentions.updateActiveNote();
		let off = noop;
		await act(async () => {
			off = svc.subscribeSelectionChanges(() => void refresh());
		});
		const shown = () => h.input.suggestions.mentions.activeNote?.selection;
		expect(shown()?.file).toBe(a.original);
		if (mode !== "stable") {
			a.swap();
			view.file = a.other;
			Object.assign(h.plugin.app.workspace, {
				getActiveViewOfType: () => null,
			});
			// Focus moves to chat: cached selection stays, no selection event on the occupant.
			const leafChange = h.events.get("active-leaf-change") as (
				leaf: unknown,
			) => void;
			await act(async () => leafChange({ view: {} }));
			expect(shown()?.file).not.toBe(a.other);
		}
		await act(async () => h.input.onSendMessage("about this passage"));
		off();
		if (mode === "stable") {
			expect(m.confirm).not.toHaveBeenCalled();
			expect(h.prompt).toHaveBeenCalledTimes(1);
		} else expect(h.prompt).not.toHaveBeenCalled();
	},
);

it.each(["same ownership", "owner returned"])(
	"D1 the destination witness lives with its composer ownership: %s",
	async (mode) => {
		const before = "# Plan\nBODY\n";
		const h = await mount({ tools: true, messages: [literalReply] });
		const a = attachVault(h, fakeFile("Brief.md"), before);
		openSourceEditor(h, a);
		await act(async () => h.row.onTools());
		await chooseSectionDestination(h);
		if (mode === "owner returned") {
			// The reused panel owns C, then A again; A's anchor survives, its old choice must not.
			h.session.sessionId = "C";
			await h.render();
			h.session.sessionId = "A";
			await h.render();
		}
		expect((await load(h)).destination).toBeDefined();
		await act(async () => proposalActions(h)!.onInsert());
		if (mode === "same ownership") {
			expect(a.v.process).toHaveBeenCalledExactlyOnceWith(
				a.original,
				expect.any(Function),
			);
			return;
		}
		expect(a.v.process).not.toHaveBeenCalled();
		expect([...a.data.values()]).toEqual([before, before]);
		expect(m.notice.mock.calls.flat().join(" ")).toMatch(
			/choose the destination again/i,
		);
	},
);

it.each(["selection on B", "A returns before send"])(
	"D2 a selection event binds the leaf's file at that event: %s",
	async (mode) => {
		const h = await mount({ follow: true });
		const a = attachVault(h);
		a.data.set(a.original, "HEADBODY-A");
		a.data.set(a.other, "DIFFBODY-B");
		const view = openSourceEditor(h, a);
		let state = EditorState.create(),
			start = 0,
			active = true;
		Object.assign(view.editor, {
			getValue: () => a.data.get(view.file)!,
			somethingSelected: () => true,
			hasFocus: () => true,
			listSelections: () => [
				{
					anchor: { line: 0, ch: start },
					head: { line: 0, ch: start + 4 },
				},
			],
			cm: {
				dispatch: (spec: TransactionSpec) => {
					state = state.update(spec).state;
				},
			},
		});
		// The path resolves to whichever file the leaf shows now.
		Object.assign(a.v, {
			on: () => ({}),
			getMarkdownFiles: () => [view.file],
			getAbstractFileByPath: () => view.file,
		});
		h.vaultAccess.readNote = async () => a.data.get(view.file);
		Object.assign(h.plugin.app, {
			metadataCache: { getFileCache: () => ({}) },
		});
		Object.assign(h.plugin.app.workspace, {
			getActiveViewOfType: () => (active ? view : null),
		});
		// Real tracker; the fixture plugin is the same shape the harness passes elsewhere.
		const svc = new VaultService(h.plugin as never);
		Object.assign(h.vaultAccess, {
			getActiveNote: () => svc.getActiveNote(),
			captureActiveSelection: (caret?: boolean) =>
				svc.captureActiveSelection(caret),
		});
		const refresh = () => h.input.suggestions.mentions.updateActiveNote();
		let off = noop;
		await act(async () => {
			off = svc.subscribeSelectionChanges(() => void refresh());
		});
		const shown = () => h.input.suggestions.mentions.activeNote?.selection;
		expect(shown()?.file).toBe(a.original);
		// The same leaf now shows B; no leaf change, only a genuine selection on B.
		view.file = a.other;
		start = 4;
		const listeners = state.facet(EditorView.updateListener);
		expect(listeners).toHaveLength(1);
		// The listener reads only these two update flags.
		const update = { selectionSet: true, docChanged: false } as ViewUpdate;
		await act(async () => listeners[0](update));
		expect(shown()?.text).toBe("BODY");
		expect(shown()?.file).toBe(a.other);
		if (mode === "A returns before send") {
			active = false;
			const leafChange = h.events.get("active-leaf-change") as (
				leaf: unknown,
			) => void;
			await act(async () => leafChange({ view: {} }));
			view.file = a.original;
			await act(async () => refresh());
		}
		await act(async () => h.input.onSendMessage("about this passage"));
		off();
		if (mode === "selection on B") {
			expect(m.confirm).not.toHaveBeenCalled();
			expect(h.prompt).toHaveBeenCalledTimes(1);
		} else expect(h.prompt).not.toHaveBeenCalled();
	},
);
