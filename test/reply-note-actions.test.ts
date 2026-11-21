import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
	insertReply,
	type LiteralTarget,
} from "../src/services/reply-note-action";
import { ReplyNoteActions } from "../src/ui/ReplyNoteActions";
import type { ChatMessage } from "../src/types/chat";
import type { NoteEditProposal } from "../src/types/note-companion";
import { planLiteralEdit } from "../src/services/note-edit-planner";

const reply: ChatMessage = {
	id: "original",
	role: "assistant",
	content: [{ type: "text", text: "👋\r\nExact" }],
	timestamp: new Date(0),
};
const path = "Target.md";
const before = "🌱\r\nroot";
const apply = vi.fn(async (_id: string, proposal: NoteEditProposal) => ({
	operationId: proposal.id,
	path,
	status: "verified" as const,
}));

it("appends literal text from the original reply to an explicitly chosen note end", async () => {
	let select!: (value: LiteralTarget) => void;
	const choice = new Promise<LiteralTarget>((resolve) => {
		select = resolve;
	});
	const message = structuredClone(reply);
	const task = insertReply({
		sessionId: "s1",
		message,
		destination: null,
		choose: () => choice,
		read: async () => before,
		current: () => true,
		apply,
	});
	message.id = "latest";
	message.content = [{ type: "text", text: "Don't insert" }];
	select({ path, kind: "end", stillTarget: () => true });
	await expect(task).resolves.toMatchObject({ status: "verified" });
	const [id, proposal] = apply.mock.lastCall!;
	expect(id).toBe("s1");
	expect(proposal).toMatchObject({ sourceMessageId: "original", before });
	expect(proposal.after).toContain("👋\r\nExact");
});

it("never writes after an owner change during a note read", async () => {
	const write = vi.fn<typeof apply>();
	const base = {
		sessionId: "s1",
		message: reply,
		read: async () => before,
		current: () => true,
		apply: write,
	};
	let live = true;
	const choose = vi.fn(async () => null);
	await insertReply({
		...base,
		destination: { kind: "end", path },
		// The saved destination now needs its choice witness to proceed at all.
		bindTarget: () => () => true,
		choose,
		current: () => live,
		read: async () => {
			live = false;
			return before;
		},
	});
	expect(choose).not.toHaveBeenCalled();
	expect(write).not.toHaveBeenCalled();
});

it("renders the real reply diff before Accept and Cancel, not a generic insert", () => {
	const proposal = planLiteralEdit(
		{ path, text: before, capturedAt: 0 },
		{ kind: "range", path, range: { start: 4, end: 8 } },
		"new",
		"original",
	);
	const html = renderToStaticMarkup(
		React.createElement(ReplyNoteActions, {
			insertLabel: "Insert in note…",
			onInsert: vi.fn(),
			proposals: [{ proposal }],
			receipts: [],
			disabled: false,
			onAccept: vi.fn(),
			onCancel: vi.fn(),
			onUndo: vi.fn(),
			onReconcile: vi.fn(),
		}),
	);
	expect(html).toContain("xo-note-diff-removed");
	expect(html).toContain("xo-note-diff-added");
	expect(html.indexOf("Before and after diff")).toBeLessThan(
		html.indexOf(">Accept<"),
	);
	expect(html).toContain(">Cancel<");
	expect(html).not.toContain("Insert in note");
});
