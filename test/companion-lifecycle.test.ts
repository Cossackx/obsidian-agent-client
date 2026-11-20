import { useRestoreOwner } from "../src/hooks/useRestoreOwner";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { useCompanionComposer } from "../src/hooks/useCompanionComposer";
import { useNoteCompanion } from "../src/hooks/useNoteCompanion";
import {
	useAgentMessages,
	type SendMessageOptions,
} from "../src/hooks/useAgentMessages";
import { useChatActions } from "../src/hooks/useChatActions";
import { useSuggestions } from "../src/hooks/useSuggestions";
import { useSessionHistory } from "../src/hooks/useSessionHistory";
import { useHistoryModal } from "../src/hooks/useHistoryModal";
import { usePersistentEmbedRestore } from "../src/hooks/usePersistentEmbedRestore";
import { CompanionStorage } from "../src/services/companion-storage";
import { prepareContext } from "../src/services/context-builder";
import { compareSource } from "../src/services/source-comparison";
import { preparePrompt } from "../src/services/message-sender";
import { ChatViewRegistry } from "../src/services/view-registry";
import {
	ChatContextProvider,
	type ChatContextValue,
} from "../src/ui/ChatContext";
import { ContextTray, type StructuredTurn } from "../src/ui/ContextTray";
import type { ContextItem } from "../src/types/note-companion";

const notice = vi.hoisted(() => vi.fn());
const modal = vi.hoisted(() => ({
	props: undefined as
		| { onRestoreSession: (id: string, cwd: string) => Promise<void> }
		| undefined,
}));
vi.mock("obsidian", async (original) => ({
	...(await original<object>()),
	Notice: class {
		constructor(message: string) {
			notice(message);
		}
	},
	Modal: class {},
	MarkdownView: class {},
}));
vi.mock("../src/ui/SessionHistoryModal", () => ({
	SessionHistoryModal: class {
		constructor(_: unknown, props: typeof modal.props) {
			modal.props = props;
		}
		open() {}
		updateProps(props: typeof modal.props) {
			modal.props = props;
		}
	},
}));
vi.mock("../src/hooks/useSettings", () => ({
	useSettingsSelector: () => ({ currentVaultOnly: true }),
	selectHistoryFilters: () => ({}),
	historyFiltersEqual: () => true,
}));

const noop = () => undefined;
const subscribe = () => noop;
const doc = { nodeType: 9, addEventListener: noop, activeElement: null };
const roots = new Set<ReturnType<typeof createRoot>>();
beforeEach(() => {
	vi.stubGlobal("document", doc);
	vi.stubGlobal("window", {
		document: doc,
		HTMLIFrameElement: class {},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: noop,
	});
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	notice.mockClear();
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount();
	});
	roots.clear();
	vi.unstubAllGlobals();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { resolve, promise };
}
function fixture() {
	const files = new Map<string, string>();
	let fail = false;
	const adapter = {
		exists: async (path: string) => path === "journal" || files.has(path),
		list: async () => ({ files: [...files.keys()], folders: [] }),
		write: async (path: string, text: string) => {
			if (fail) {
				fail = false;
				throw new Error("fixture failure");
			}
			files.set(path, text);
		},
		read: async (path: string) => files.get(path),
		mkdir: noop,
		remove: async (path: string) => {
			files.delete(path);
		},
	} as unknown as DataAdapter;
	const restart = () => new CompanionStorage(adapter, "journal");
	return {
		store: restart(),
		restart,
		fail: () => {
			fail = true;
		},
	};
}
const displaySettings = { maxNoteLength: 3, maxSelectionLength: 100 };
const item: ContextItem = {
	id: "passage",
	source: { path: "Exact.md", text: "h\nABC\nnext", capturedAt: 0 },
	scope: { kind: "passage", range: { start: 2, end: 6 } },
	role: "working",
	lifetime: "session",
};
async function mount<T>(
	work: () => T,
	store = fixture().store,
	vaultService: object = {},
) {
	let value!: T;
	const container = {
		nodeType: 1,
		tagName: "DIV",
		ownerDocument: doc,
		namespaceURI: "http://www.w3.org/1999/xhtml",
		addEventListener: noop,
	};
	const root = createRoot(container as unknown as Element);
	roots.add(root);
	const context = {
		plugin: {
			app: {},
			settings: { displaySettings },
			companionStorage: store,
		},
		vaultService,
	} as unknown as ChatContextValue;
	function Harness() {
		value = work();
		return null;
	}
	const render = () =>
		act(async () =>
			root.render(
				createElement(
					ChatContextProvider,
					{ value: context },
					createElement(Harness),
				),
			),
		);
	await render();
	return {
		get current() {
			return value;
		},
		render,
		close: async () => {
			await act(async () => root.unmount());
			roots.delete(root);
		},
	};
}

it("post-confirmation completion and attachment reads cannot modify a reopened same-ID composer", async () => {
	const disk = fixture();
	const old = await mount(() => useCompanionComposer("A"), disk.store);
	await act(async () => {
		old.current.changeDraft("first");
		await old.current.companion.flush();
	});
	const index = deferred();
	const sent = vi.fn();
	const won = old.current.send(async () => {
		sent();
		await index.promise;
		return true;
	});
	const lateAttachment = old.current.changeFiles;
	await old.close();
	const reopened = await mount(
		() => useCompanionComposer("A"),
		disk.restart(),
	);
	await act(async () => {
		reopened.current.changeDraft("new owner");
		await reopened.current.companion.flush();
	});
	await act(async () => {
		index.resolve();
		await won;
		lateAttachment([{ id: "old-file", kind: "file", mimeType: "" }]);
	});
	expect(sent).toHaveBeenCalledTimes(1);
	expect(reopened.current.attachedFiles).toEqual([]);
	expect((await disk.restart().load("A"))?.draft).toBe("new owner");
});

it("typing accepted before sidecar load stays visible and durable", async () => {
	const disk = fixture();
	await disk.store.update("A", (old) => ({ ...old, draft: "old sidecar" }));
	const gate = deferred();
	const reader = disk.restart();
	vi.spyOn(disk.store, "load").mockImplementation(async (id) => {
		const prior = await reader.load(id);
		await gate.promise;
		return prior;
	});
	const view = await mount(() => useCompanionComposer("A"), disk.store);
	expect(view.current.companion.state).toBeNull();
	await act(async () => {
		view.current.changeDraft("typed while loading");
		await view.current.companion.flush();
	});
	await act(async () => {
		gate.resolve();
		await gate.promise;
	});
	expect(view.current.inputValue).toBe("typed while loading");
	expect((await disk.restart().load("A"))?.draft).toBe("typed while loading");
});

it("a late successful send preserves newer edits and files, including after A/B/A rebind", async () => {
	let id = "A";
	const gate = deferred();
	const disk = fixture();
	const view = await mount(() => useCompanionComposer(id), disk.store);
	await act(async () => view.current.changeDraft("first"));
	const send = view.current.send(async () => {
		await gate.promise;
		return true;
	});
	const oldFiles = view.current.changeFiles;
	const newer = { id: "new", kind: "file" as const, mimeType: "" };
	await act(async () => {
		view.current.changeDraft("newer");
		view.current.changeFiles([newer]);
		gate.resolve();
		await send;
		await view.current.companion.flush();
	});
	expect(view.current.attachedFiles).toEqual([newer]);
	expect(view.current.inputValue).toBe("newer");
	id = "B";
	await view.render();
	await act(async () => oldFiles([newer]));
	expect(view.current.attachedFiles).toEqual([]);
	id = "A";
	await view.render();
	await act(async () => oldFiles([newer]));
	expect(view.current.attachedFiles).toEqual([]);
	expect(view.current.inputValue).toBe("newer");
});

it("save retries retain independent failed intents and do not replay a superseded edit", async () => {
	const disk = fixture();
	const view = await mount(() => useNoteCompanion("A", noop), disk.store);
	await act(async () => {
		disk.fail();
		await view.current.update(
			(old) => ({ ...old, items: [item] }),
			"add:passage",
		);
		await view.current.update(
			(old) => ({ ...old, compact: true }),
			"density",
		);
	});
	expect(view.current.warning).toContain("fixture failure");
	await act(async () => view.current.retry());
	const edit = (annotation: string) =>
		view.current.update(
			(old) => ({
				...old,
				items: old.items.map((row) => ({ ...row, annotation })),
			}),
			"item:passage:annotation",
		);
	await act(async () => {
		disk.fail();
		await edit("old");
		await edit("latest");
		await view.current.retry();
	});
	const saved = await disk.restart().load("A");
	expect(saved?.compact).toBe(true);
	expect(saved?.items).toMatchObject([{ id: item.id, annotation: "latest" }]);
});

it("ordinary history callbacks for a listed or entered ID cannot mutate a conversation owned elsewhere", async () => {
	const target = "owned";
	const registry = new ChatViewRegistry();
	const unregister = registry.trackConversationOwner(
		"other-embed",
		() => target,
	);
	const onSessionLoad = vi.fn(),
		loadSession = vi.fn(async () => ({ sessionId: target })),
		clear = vi.fn(),
		cwdChange = vi.fn();
	const plugin = {
		app: {},
		settingsService: {
			loadSessionMessages: async () => null,
			getSavedSessions: () => [],
			subscribe,
		},
	};
	const view = await mount(() => {
		const withRestoreOwner = useRestoreOwner(
			registry,
			"history",
			async () => noop,
		);
		const history = useSessionHistory({
			agentClient: {
				getSessionRestoreCapabilities: () => ({ load: true }),
				loadSession,
			} as never,
			session: {
				sessionId: "initial",
				agentId: "test",
				agentCapabilities: { loadSession: true },
			} as never,
			settingsAccess: plugin.settingsService as never,
			cwd: "/test",
			agentCwd: "/test",
			onSessionLoad,
			onClearMessages: clear,
			withRestoreOwner,
		});
		return useHistoryModal(
			plugin as never,
			{ clearMessages: clear } as never,
			history,
			"/test",
			true,
			false,
			cwdChange,
		);
	});
	await act(async () => view.current.handleOpenHistory());
	// Both UI entry points forward these values to the installed modal callback.
	await act(async () => {
		await modal.props?.onRestoreSession(target, "/listed");
		await modal.props?.onRestoreSession(target, "/entered");
	});
	expect(notice).toHaveBeenCalledWith(expect.stringContaining("owner"));
	expect(loadSession).not.toHaveBeenCalled();
	expect(onSessionLoad).not.toHaveBeenCalled();
	expect(clear).not.toHaveBeenCalled();
	expect(cwdChange).not.toHaveBeenCalled();
	unregister();
	await act(async () => modal.props?.onRestoreSession(target, "/listed"));
	expect(loadSession).toHaveBeenCalledExactlyOnceWith(target, "/listed");
	expect(cwdChange).toHaveBeenCalledExactlyOnceWith("/listed");
});

it.each([true, false])(
	"persistent embed checks ownership before route changes or load (blocked=%s)",
	async (blocked) => {
		const registry = new ChatViewRegistry();
		const target = "saved-embed";
		if (blocked)
			registry.trackConversationOwner("another-view", () => target);
		const restart = vi.fn(async () => {
			expect(() => registry.reserveRestore(target, "racer")).toThrow(
				/owner/,
			);
		});
		const cwd = vi.fn(),
			identity = vi.fn(),
			loadSession = vi.fn(async () => ({ sessionId: target }));
		const settings = {
			getSavedSessionByEmbedId: () => ({
				sessionId: target,
				cwd: "/saved",
				agentId: "saved-adapter",
			}),
		};
		await mount(() => {
			const withRestoreOwner = useRestoreOwner(
				registry,
				"embed",
				async () => noop,
			);
			const history = useSessionHistory({
				agentClient: {
					getSessionRestoreCapabilities: () => ({ load: true }),
					loadSession,
				} as never,
				session: {
					sessionId: "bootstrap",
					agentId: "current-adapter",
				} as never,
				settingsAccess: {
					loadSessionMessages: async () => null,
					subscribe,
				} as never,
				cwd: "/test",
				agentCwd: "/test",
				onSessionLoad: identity,
				withRestoreOwner,
			});
			usePersistentEmbedRestore(
				"persistent-id",
				"bootstrap",
				"current-adapter",
				settings as never,
				history,
				restart,
				cwd,
			);
		});
		if (blocked) {
			expect(notice).toHaveBeenCalledWith(
				expect.stringContaining("owner"),
			);
			for (const effect of [restart, cwd, identity, loadSession])
				expect(effect).not.toHaveBeenCalled();
		} else {
			expect(restart).toHaveBeenCalledExactlyOnceWith(
				"saved-adapter",
				"/saved",
			);
			expect(loadSession).toHaveBeenCalledExactlyOnceWith(
				target,
				"/saved",
			);
			expect(cwd).toHaveBeenCalledExactlyOnceWith("/saved");
		}
	},
);

it("a delayed stop cannot replace a draft typed in the next conversation", async () => {
	const gate = deferred();
	let id = "A";
	const disk = fixture();
	const view = await mount(() => {
		const composer = useCompanionComposer(id);
		const actions = useChatActions(
			{} as never,
			{
				cancelOperation: () => gate.promise,
				lastUserMessage: "old prompt",
			} as never,
			{} as never,
			{ mentions: {} } as never,
			{ sessionId: id } as never,
			[],
			{} as never,
			"/test",
		);
		return { composer, actions };
	}, disk.store);
	await act(async () => {
		view.current.composer.changeDraft("old prompt");
		await view.current.composer.companion.flush();
	});
	const stop = view.current.actions.handleStopGeneration();
	id = "B";
	await view.render();
	await act(async () => {
		view.current.composer.changeDraft("new draft");
		gate.resolve();
		await stop;
		await view.current.composer.companion.flush();
	});
	expect(view.current.composer.inputValue).toBe("new draft");
	expect("restoredMessage" in view.current.actions).toBe(false);
	expect((await disk.restart().load("A"))?.draft).toBe("old prompt");
	expect((await disk.restart().load("B"))?.draft).toBe("new draft");
});

it.each([false, true])(
	"fresh conversation gets a different ID and preserves the old draft (live=%s)",
	async (live) => {
		let id = "original";
		const disk = fixture();
		const restart = vi.fn(async () => {
			id = "fresh";
		});
		const sendMessage = vi.fn();
		const view = await mount(() => {
			const composer = useCompanionComposer(id);
			const actions = useChatActions(
				{ settings: { autoMentionActiveNote: false } } as never,
				{
					isReady: true,
					restartSession: restart,
					clearMessages: noop,
					sendMessage,
				} as never,
				{ invalidateCache: noop } as never,
				{ mentions: { toggleAutoMention: noop } } as never,
				{ sessionId: id, agentId: "synthetic" } as never,
				[],
				{} as never,
				"/test",
				undefined,
				live,
			);
			return { composer, actions };
		}, disk.store);
		await act(async () => view.current.composer.changeDraft("unsent work"));
		await act(async () => {
			await view.current.composer.companion.flush();
			await view.current.actions.handleNewChat(undefined, live);
		});
		await view.render();
		expect(id).toBe("fresh");
		expect(restart).toHaveBeenCalledTimes(1);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(view.current.composer.inputValue).toBe("");
		expect((await disk.restart().load("original"))?.draft).toBe(
			"unsent work",
		);
	},
);

const settingsAccess = {
	getSnapshot: () => ({
		displaySettings,
		promptInjection: { enabled: false },
	}),
};
it.each([false, true])(
	"configured-off active note never reaches outbound payload after New chat, embedded=%s",
	async (embeddedContext) => {
		const wire = vi.fn();
		const vault = {
			getActiveNote: async () => ({
				path: "Not sent.md",
				selection: {
					text: "PRIVATE_ACTIVE_MARKER",
					from: { line: 0, ch: 0 },
					to: { line: 0, ch: 21 },
				},
			}),
			getAllFiles: () => [],
		};
		let id = "A";
		const plugin = {
			settings: { autoMentionActiveNote: false, exportSettings: {} },
			settingsService: { getSavedSessions: () => [{ sessionId: id }] },
		};
		const view = await mount(() => {
			const session = {
				sessionId: id,
				agentId: "agent",
				promptCapabilities: { embeddedContext },
			} as never;
			const messages = useAgentMessages(
				{
					hasLiveSession: () => true,
					sendPrompt: async (_: string, blocks: unknown) => {
						wire(blocks);
					},
				} as never,
				settingsAccess as never,
				vault as never,
				session,
				noop,
			);
			const suggestions = useSuggestions(
				vault as never,
				plugin as never,
				[],
				false,
			);
			const actions = useChatActions(
				plugin as never,
				{
					...messages,
					restartSession: async () => {
						id = "B";
					},
				} as never,
				{ invalidateCache: noop } as never,
				suggestions,
				session,
				[{ role: "assistant" }] as never,
				{} as never,
				"/test",
				undefined,
				true,
			);
			return { suggestions, actions };
		});
		await act(async () =>
			view.current.suggestions.mentions.updateActiveNote(),
		);
		await act(async () => view.current.actions.handleNewChat());
		await view.render();
		expect(id).toBe("B");
		expect(view.current.suggestions.mentions.isAutoMentionDisabled).toBe(
			true,
		);
		await act(async () => {
			await view.current.actions.handleSendMessage("Hello", undefined, {
				approvePayload: async () => true,
			});
		});
		expect(wire).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(wire.mock.calls)).not.toContain(
			"PRIVATE_ACTIVE_MARKER",
		);
	},
);

function button(
	node: ReactElement,
	text: string,
): { onClick: () => void } | undefined {
	const visit = (value: unknown): { onClick: () => void } | undefined => {
		if (Array.isArray(value)) {
			for (const child of value as unknown[]) {
				const hit = visit(child);
				if (hit) return hit;
			}
			return;
		}
		if (!value || typeof value !== "object" || !("props" in value)) return;
		const element = value as ReactElement<{
			children: unknown;
			onClick?: () => void;
		}>;
		const children = element.props.children;
		const label =
			Array.isArray(children) &&
			children.every((child: unknown) => typeof child === "string")
				? children.join("")
				: children;
		if (
			element.type === "button" &&
			label === text &&
			element.props.onClick
		)
			return { onClick: element.props.onClick };
		return visit(element.props.children);
	};
	return visit(node);
}

it("real synthesis callback requires a correlated reply, not a session-local old chunk", async () => {
	const disk = fixture();
	await disk.store.update("A", (old) => ({ ...old, items: [item] }));
	let text = "Old chunk only",
		options: SendMessageOptions | undefined;
	let enqueue!: ReturnType<typeof useAgentMessages>["enqueueUpdate"];
	const view = await mount(() => {
		const messages = useAgentMessages(
			{
				hasLiveSession: () => true,
				sendPrompt: async () =>
					enqueue({
						type: "agent_message_chunk",
						text,
						sessionId: "A",
					}),
			} as never,
			settingsAccess as never,
			{} as never,
			{ sessionId: "A" } as never,
			noop,
		);
		enqueue = messages.enqueueUpdate;
		const companion = useNoteCompanion("A", noop);
		async function send(turn: StructuredTurn) {
			const id = "request-B";
			options = {
				vaultBasePath: "/test",
				generatedInstruction: turn.text,
				structuredRequestId: id,
				approvePayload: async () => true,
				onConfirmed: (raw, _userId, replyId) => {
					if (replyId)
						turn.onReply?.(
							(JSON.parse(raw) as { result: unknown }).result,
							replyId,
						);
				},
			};
			await messages.sendMessage(turn.intent ?? "synthesis", options);
			return true;
		}
		return {
			tray: ContextTray({
				companion,
				canSend: true,
				busy: false,
				messages: messages.messages,
				send,
			} as never),
			messages: messages.messages,
		};
	}, disk.store);
	await act(async () =>
		button(view.current.tray, "Bring these together")?.onClick(),
	);
	expect(options?.generatedInstruction).toContain("string value");
	expect(button(view.current.tray, "Exact.md · passage 2–6")).toBeUndefined();
	expect(
		view.current.messages.some((message) =>
			JSON.stringify(message).includes("Old chunk only"),
		),
	).toBe(true);
	text = JSON.stringify({
		requestId: "request-B",
		result: "Verified response",
	});
	await act(async () =>
		button(view.current.tray, "Bring these together")?.onClick(),
	);
	expect(
		view.current.messages.some((message) =>
			JSON.stringify(message).includes("Verified response"),
		),
	).toBe(true);
	expect(button(view.current.tray, "Exact.md · passage 2–6")).toBeDefined();
});

it.each([false, true])(
	"typed editorial quotes record only transmitted extent in sidecar; embedded=%s",
	async (embeddedContext) => {
		const prepared = prepareContext([], {
			...displaySettings,
			embeddedContext,
			quotes: [
				{
					label: "Template",
					text: "ABC_PRIVATE_TAIL",
					limit: "note",
					source: {
						path: "Template.md",
						capturedAt: 1,
						scope: { kind: "note" },
						kind: "template",
					},
				},
				{
					label: "Approved section",
					text: "section-only\n",
					limit: "selection",
					source: {
						path: "Destination.md",
						capturedAt: 2,
						scope: {
							kind: "heading",
							heading: "Target",
							occurrence: 1,
							range: { start: 9, end: 22 },
						},
						kind: "approved-destination",
					},
				},
			],
		});
		const outbound = await preparePrompt(
			{
				message: "Editorial intent",
				generatedInstruction: "Propose without tools",
				supportsEmbeddedContext: embeddedContext,
				preparedContext: prepared,
				vaultBasePath: "/test",
			},
			{} as never,
			{} as never,
		);
		expect(JSON.stringify(outbound.agentContent)).toContain("section-only");
		expect(JSON.stringify(outbound.agentContent)).not.toContain(
			"PRIVATE_TAIL",
		);
		expect(outbound.sources).toMatchObject([
			{
				path: "Template.md",
				text: "ABC",
				originalLength: 16,
				quoteKind: "template",
			},
			{
				path: "Destination.md",
				text: "section-only\n",
				quoteKind: "approved-destination",
			},
		]);
		expect(
			compareSource(outbound.sources[1], {
				path: "Destination.md",
				capturedAt: 0,
				text: "# Target\nsection-only\n",
			}).changed,
		).toBe(false);
		const disk = fixture();
		const view = await mount(() => useNoteCompanion("A", noop), disk.store);
		await act(async () =>
			view.current.confirmed(
				{ ...prepared, sources: outbound.sources },
				"sent",
			),
		);
		expect((await disk.restart().load("A"))?.sent[0].sources).toEqual(
			outbound.sources,
		);
	},
);

it("LF passage compares at its exact logical extent against saved CRLF", () => {
	const [sent] = prepareContext([item], {
		...displaySettings,
		embeddedContext: true,
	}).sources;
	const current = { ...item.source, text: "h\r\nABC\r\nnext" };
	expect(compareSource(sent, current)).toMatchObject({
		changed: false,
		after: "ABC\n",
	});
	expect(
		compareSource(sent, { ...current, text: "h\r\nXYZ\r\nABC" }).changed,
	).toBe(true);
});
