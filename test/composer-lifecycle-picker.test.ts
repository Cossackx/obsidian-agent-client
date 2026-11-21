import { it, expect, vi } from "vitest";
import { TFile } from "obsidian";
import { chooseReplyTarget } from "../src/ui/ReplyTargetPicker";
import { insertReply } from "../src/services/reply-note-action";
import { NoteActionService } from "../src/services/note-action-service";
import { CompanionStorage } from "../src/services/companion-storage";
const m = vi.hoisted(() => ({ opened: null as any }));
vi.mock("obsidian", async (orig) => ({
	...(await orig<any>()),
	FuzzySuggestModal: class {
		open() {
			m.opened = this;
		}
		onClose() {}
	},
}));
it("X13 stable picker preserves exact CRLF, Unicode and literal markup; rebuild Undo", async () => {
	const crlf = String.fromCharCode(13, 10),
		first = ["First", "line"].join(crlf),
		literal = ["  😀 **raw**", String.fromCharCode(9) + "$1  "].join(crlf);
	const path = "Draft.md",
		original = new TFile(path, "Draft"),
		replacement = new TFile(path, "Draft");
	let file = original;
	const bytes = new Map([
		[original, first],
		[replacement, "Other document"],
	]);
	const v = {
		getMarkdownFiles: () => [file],
		getAbstractFileByPath: (p) => (p === file.path ? file : null),
		read: async (f) => bytes.get(f),
		process: async (f, fn) => {
			bytes.set(f, fn(bytes.get(f)));
			return bytes.get(f);
		},
	};
	const slots = new Map();
	const st = new CompanionStorage(
		{
			exists: async (p) => p === "side" || slots.has(p),
			read: async (p) => slots.get(p),
			write: async (p, t) => slots.set(p, t),
			list: async () => ({ files: [...slots.keys()], folders: [] }),
		} as never,
		"side",
	);
	const svc = new NoteActionService(v as never, st);
	const pending = insertReply({
		sessionId: "A",
		message: {
			id: "first",
			role: "assistant",
			content: [{ type: "text", text: literal }],
		},
		choose: () => chooseReplyTarget({ vault: v } as never),
		current: () => true,
		read: async (p) => v.read(v.getAbstractFileByPath(p)),
		apply: (...args) => svc.apply(...args),
	} as never);
	const choice = m.opened.getItems()[0];
	expect(m.opened.getItemText(choice)).toBe("Append to Draft.md");

	m.opened.onChooseItem(choice);
	const outcome = await pending.catch((e) => ({
		status: e.name,
		message: e.message,
	}));
	const after = [first, literal, ""].join(crlf);
	const [op] = (await st.load("A")).operations;
	expect(outcome.status).toBe("verified");
	expect(bytes.get(original)).toBe(after);
	expect(op.proposal.after).toBe(after);
	expect(op.proposal.target).toEqual({ kind: "end", path });
	expect(
		await new NoteActionService(v as never, st).undo("A", op.proposal.id),
	).toMatchObject({ status: "undone" });
	expect(bytes.get(original)).toBe(first);
});
