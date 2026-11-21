import { it, expect, vi } from "vitest";
import { TFile, type FuzzySuggestModal } from "obsidian";
import { chooseReplyTarget } from "../src/ui/ReplyTargetPicker";
import { insertReply } from "../src/services/reply-note-action";
import { NoteActionService } from "../src/services/note-action-service";
import { CompanionStorage } from "../src/services/companion-storage";
type PickerModal = Pick<
	FuzzySuggestModal<unknown>,
	"getItems" | "getItemText"
> & { onChooseItem(item: unknown): void };
const m = vi.hoisted(() => ({
	opened: undefined as PickerModal | undefined,
}));
vi.mock("obsidian", async (orig) => ({
	...(await orig<object>()),
	FuzzySuggestModal: class {
		open(this: PickerModal) {
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
	const file = original;
	const bytes = new Map([
		[original, first],
		[replacement, "Other document"],
	]);
	const v = {
		getMarkdownFiles: () => [file],
		getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
		read: async (f: TFile) => bytes.get(f)!,
		process: async (f: TFile, fn: (data: string) => string) => {
			bytes.set(f, fn(bytes.get(f)!));
			return bytes.get(f);
		},
	};
	const slots = new Map<string, string>();
	const st = new CompanionStorage(
		{
			exists: async (p: string) => p === "side" || slots.has(p),
			read: async (p: string) => slots.get(p),
			write: async (p: string, t: string) => slots.set(p, t),
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
		read: async (p) => v.read(v.getAbstractFileByPath(p)!),
		apply: (...args) => svc.apply(...args),
	} as Parameters<typeof insertReply>[0]);
	const opened = m.opened!;
	const choice = opened.getItems()[0];
	expect(opened.getItemText(choice)).toBe("Append to Draft.md");

	opened.onChooseItem(choice);
	const outcome = await pending.catch((e: Error) => ({
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
