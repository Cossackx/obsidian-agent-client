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
const m = vi.hoisted(() => ({
	notice: vi.fn<(message: string) => void>(),
	confirm: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
	agent: undefined as
		| ((...args: Parameters<typeof useAgent>) => unknown)
		| undefined,
	picker: vi.fn<(...args: unknown[]) => unknown>(),
	menu: [] as MenuRow[],
}));
vi.mock("obsidian", async (orig) => ({
	...(await orig<object>()),
	Modal: class {},
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
		verifyNext = 0,
		failVerify = 0;
	const adapter = {
		exists: async (p: string) => p === "side" || files.has(p),
		read: async (p: string) => {
			if (failVerify) {
				failVerify--;
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
				failVerify = verifyNext;
				verifyNext = 0;
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
import { NoteActionService } from "../src/services/note-action-service";
function attachVault(h: Mounted) {
	const original = fakeFile("Brief.md"),
		other = fakeFile("Brief.md"),
		data = new Map<TFile, string>([
			[original, "BODY"],
			[other, "BODY"],
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
function wireRevision(h: Mounted, itemId: string) {
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
				result: [{ itemId, original: "BODY", replacement: "EDIT" }],
			}),
		);
	});
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
