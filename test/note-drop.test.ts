import { expect, it, vi } from "vitest";
import {
	routeVaultDrop,
	stageDroppedNotes,
} from "../src/services/stage-note-drop";
import { emptyCompanion } from "../src/services/companion-state";
import type { ContextItem } from "../src/types/note-companion";

it("routes a mixed drop once per note, keeps attachments, and reports both skips and failures", async () => {
	const stage = vi.fn(async () => {
		throw new Error("Could not read A.md");
	});
	const attach = vi.fn();
	const notice = vi.fn();
	const convert = vi.fn(async (files: string[]) =>
		files.map((name) => ({ name })),
	);
	await routeVaultDrop(
		{
			notes: [{ path: "A.md" }, { path: "A.md" }, { path: "sub/A.md" }],
			files: ["photo.png", "doc.pdf"],
			skippedCount: 1,
		},
		{ stage, convert, attach, notice },
	);
	expect(stage).toHaveBeenCalledExactlyOnceWith(["A.md", "sub/A.md"]);
	expect(attach).toHaveBeenCalledExactlyOnceWith([
		{ name: "photo.png" },
		{ name: "doc.pdf" },
	]);
	expect(notice.mock.calls.flat()).toEqual([
		"Folders cannot be attached.",
		"Could not read A.md",
	]);
});

it("deduplicates note chips without replacing a pin or treating a passage as a full note", () => {
	const note = (id: string, path: string): ContextItem => ({
		id,
		source: { path, text: id, capturedAt: 1 },
		role: "reference",
		lifetime: "turn",
		scope: { kind: "note" },
	});
	const pin = { ...note("pin", "A.md"), lifetime: "session" as const };
	const passage = {
		...note("p", "B.md"),
		scope: { kind: "passage" as const, range: { start: 0, end: 1 } },
	};
	const state = stageDroppedNotes(
		{
			...emptyCompanion("s"),
			draft: "Typed @[[A.md]]",
			items: [pin, passage],
		},
		[
			note("newA", "A.md"),
			note("newB", "B.md"),
			note("duplicateB", "B.md"),
		],
	);
	expect(state.draft).toBe("Typed @[[A.md]]");
	expect(state.items).toEqual([pin, passage, note("newB", "B.md")]);
});
