import { expect, it, vi } from "vitest";
import { preparePrompt } from "../src/services/message-sender";
import { prepareContext } from "../src/services/context-builder";
import { selectOption } from "../src/services/message-state";
import { compareSource } from "../src/services/source-comparison";
import { decideSendReview } from "../src/services/send-review-policy";
import type { ContextItem } from "../src/types/note-companion";

const limits = {
	maxNoteLength: 3,
	maxSelectionLength: 100,
	embeddedContext: true,
};

it("never treats an approval as a rejection, even with a misleading label", () => {
	const options = [
		{ optionId: "grant", kind: "allow_always" as const, name: "Deny" },
	];
	expect(
		selectOption(options, ["reject_once", "reject_always"]),
	).toBeUndefined();
});

it.each([false, true])(
	"ignores a legacy active-note selection and infers no cached links (%s)",
	async (supportsEmbeddedContext) => {
		const getNoteWikiLinks = vi.fn(() => [
			{ linkText: "Outside", resolvedPath: "Private/Outside.md" },
		]);
		const prepared = await preparePrompt(
			{
				message: "Discuss",
				vaultBasePath: "/synthetic",
				supportsEmbeddedContext,
				activeNote: {
					path: "A.md",
					name: "A",
					modified: 0,
					created: 0,
					extension: "md",
					selection: {
						from: { line: 0, ch: 0 },
						to: { line: 0, ch: 6 },
						text: "TARGET",
					},
				} as never,
				expandWikilinkContext: true,
				wikilinkResolver: { getNoteWikiLinks },
			},
			{} as never,
			{} as never,
		);
		expect(JSON.stringify(prepared.agentContent)).not.toContain("TARGET");
		expect(prepared.sources).toEqual([]);
		expect(JSON.stringify(prepared.agentContent)).not.toContain("Outside");
		expect(getNoteWikiLinks).not.toHaveBeenCalled();
	},
);

it.each([false, true])(
	"only public linked-note metadata reaches review and dispatch (%s)",
	async (supportsEmbeddedContext) => {
		const prepared = await preparePrompt(
			{
				message: "Discuss @[[Source]]",
				vaultBasePath: "/synthetic",
				supportsEmbeddedContext,
				preparedContext: prepareContext([], {
					...limits,
					excludedPaths: ["Private/Destination.md"],
				}),
				expandWikilinkContext: true,
				wikilinkResolver: {
					getNoteWikiLinks: () => [
						{
							linkText: "PrivateAlias",
							resolvedPath: "Private/Destination.md",
						},
						{ linkText: "PublicAlias", resolvedPath: "Public.md" },
					],
				},
			},
			{ readNote: async () => "Note body" } as never,
			{
				getAllFiles: () => [
					{
						path: "Source.md",
						basename: "Source",
						stat: { mtime: 0 },
					},
				],
			} as never,
		);
		const outbound = JSON.stringify(prepared.agentContent);
		expect(outbound).toContain("PublicAlias");
		expect(outbound).not.toContain("PrivateAlias");
		expect(outbound).not.toContain("Destination.md");
		expect(prepared.sources).toHaveLength(1);
		const represented = [
			{ ...prepared.sources[0], provenance: "mention" as const },
		];
		expect(
			decideSendReview({
				sources: prepared.sources,
				represented,
				notices: prepared.notices ?? [],
				generated: false,
				requested: false,
			}).required,
		).toBe(true);
	},
);

it("keeps a destination exclusion independent of the subset being sent", () => {
	const source = { path: "Fixture.md", text: "Source", capturedAt: 0 };
	const passage: ContextItem = {
		id: "passage",
		role: "working",
		scope: { kind: "passage", range: { start: 0, end: 6 } },
		source,
		lifetime: "turn",
	};
	const options = { ...limits, excludedPaths: ["Destination.md"] };
	expect(prepareContext([passage], options).excludedPaths).toEqual([
		"Destination.md",
		"Fixture.md",
	]);
});

it("compares only the actual sent part of an unchanged truncated source", () => {
	const source = { path: "Fixture.md", text: "ABCDEF", capturedAt: 0 };
	const prepared = prepareContext(
		[
			{
				id: "note",
				role: "working",
				scope: { kind: "note" },
				source,
				lifetime: "turn",
			},
		],
		limits,
	);
	expect(compareSource(prepared.sources[0], source)).toMatchObject({
		changed: false,
		before: "ABC",
		after: "ABC",
	});
});

import { readCorrelatedReply } from "../src/services/passage-review";
import { ChatViewRegistry } from "../src/services/view-registry";
import { mapStoredRange } from "../src/utils/selection";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useChatActions } from "../src/hooks/useChatActions";
import type { SendMessageOptions } from "../src/hooks/useAgentMessages";

it.each([false, true])(
	"keeps bounded quoted source out of exportable user intent (%s)",
	async (supportsEmbeddedContext) => {
		const readNote = vi.fn(async () => "UNRELATED BODY");
		const getAllFiles = vi.fn(() => [
			{ path: "Unrelated.md", basename: "Unrelated", stat: { mtime: 0 } },
		]);
		const context = prepareContext([], {
			...limits,
			maxSelectionLength: 19,
			quotes: [
				{
					label: "Reply",
					text: "@[[Unrelated.md]] suffix excluded",
					limit: "selection",
				},
			],
		});
		const result = await preparePrompt(
			{
				message: "Request an editorial proposal",
				generatedInstruction: "Do not use tools",
				vaultBasePath: "/synthetic",
				supportsEmbeddedContext,
				preparedContext: context,
			},
			{ readNote } as never,
			{ getAllFiles } as never,
		);
		expect(result.displayContent).toEqual([
			{ type: "text", text: "Request an editorial proposal" },
		]);
		expect(JSON.stringify(result.agentContent)).toContain(
			"@[[Unrelated.md]]",
		);
		expect(JSON.stringify(result.agentContent)).not.toMatch(
			/suffix excluded|UNRELATED BODY/,
		);
		expect(readNote).not.toHaveBeenCalled();
		expect(getAllFiles).not.toHaveBeenCalled();
		expect(context.notices[0]).toMatch(/truncated/);
	},
);
it.each([false, true])(
	"records actual sent mention bytes rather than rereading (%s)",
	async (supportsEmbeddedContext) => {
		const getAllFiles = () => [
			{ path: "Fixture.md", basename: "Fixture", stat: { mtime: 0 } },
		];
		const readNote = vi.fn(async () => "ABC long tail");
		const result = await preparePrompt(
			{
				message: "Discuss @[[Fixture.md]]",
				vaultBasePath: "/synthetic",
				maxNoteLength: 3,
				supportsEmbeddedContext,
			},
			{ readNote } as never,
			{ getAllFiles } as never,
		);
		expect(result.sources).toMatchObject([
			{ path: "Fixture.md", text: "ABC", originalLength: 13 },
		]);
		expect(JSON.stringify(result.agentContent)).not.toContain("long tail");
		expect(readNote).toHaveBeenCalledTimes(1);
	},
);
it("rejects late, unwrapped, and mixed replies instead of arming a write for this turn", () => {
	const result = { path: "Same.md", markdown: "Proposed text" };
	const old = JSON.stringify({ requestId: "old", result });
	const current = JSON.stringify({ requestId: "new", result });
	expect(() => readCorrelatedReply(old, "new")).toThrow(/current request/);
	expect(() => readCorrelatedReply(JSON.stringify(result), "new")).toThrow();
	expect(() => readCorrelatedReply(old + current, "new")).toThrow();
	expect(readCorrelatedReply(current, "new")).toEqual(result);
});
it("reserves restore ownership across views before the first await", () => {
	const registry = new ChatViewRegistry();
	const release = registry.reserveRestore("history-id", "view-a");
	expect(() => registry.reserveRestore("history-id", "view-b")).toThrow(
		/owner/,
	);
	release();
	expect(() => registry.reserveRestore("history-id", "view-b")).not.toThrow();
});
it("maps LF editor offsets to saved CRLF, including an EOF caret, and rejects real edits", () => {
	const editor = "header\n🐙TAIL";
	const stored = "header\r\n🐙TAIL";
	expect(mapStoredRange(editor, stored, { start: 7, end: 9 })).toEqual({
		start: 8,
		end: 10,
	});
	expect(
		mapStoredRange(editor, stored, {
			start: editor.length,
			end: editor.length,
		}),
	).toEqual({ start: stored.length, end: stored.length });
	expect(() =>
		mapStoredRange(editor, stored + " changed", { start: 0, end: 0 }),
	).toThrow(/unsaved/);
});
it("reports a confirmed turn even if first-confirmed metadata persistence fails after prior history", async () => {
	let actions: ReturnType<typeof useChatActions> | undefined;
	const sendMessage = vi.fn(
		async (_text: string, options: SendMessageOptions) => {
			options.onConfirmed?.("fixture reply", "user", "assistant", []);
		},
	);
	const saveSessionLocally = vi.fn(async () => {
		throw new Error("fixture index failure");
	});
	function Harness() {
		actions = useChatActions(
			{ settingsService: { getSavedSessions: () => [] } } as never,
			{ sendMessage, clearError: () => undefined } as never,
			{ saveSessionLocally } as never,
			{ mentions: {} } as never,
			{
				sessionId: "fixture",
				agentId: "fixture",
				state: "ready",
			} as never,
			[{ id: "prior", role: "user", content: [], timestamp: new Date() }],
			{ windowsWslMode: false },
			"/synthetic",
		);
		return null;
	}
	renderToStaticMarkup(createElement(Harness));
	if (!actions) throw new Error("Hook harness failed to mount");
	expect(await actions.handleSendMessage("Current request")).toBe(true);
	expect(saveSessionLocally).toHaveBeenCalledTimes(1);
	expect(sendMessage).toHaveBeenCalledTimes(1);
});

vi.mock("obsidian", async (original) => ({
	...(await original<typeof import("obsidian")>()),
	Notice: class {},
}));
