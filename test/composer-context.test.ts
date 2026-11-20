import { describe, expect, it } from "vitest";
import { decideSendReview } from "../src/services/send-review-policy";
import { composerChips } from "../src/services/companion-presentation";
import type { ContextItem } from "../src/types/note-companion";

const source = (path: string, text = "body", extra = {}) => ({
	path,
	text,
	capturedAt: 1,
	scope: { kind: "note" as const },
	originalLength: text.length,
	...extra,
});
const base = { notices: [], generated: false, requested: false };

describe("decideSendReview", () => {
	it("sends a fully represented ordinary turn without review", () => {
		expect(
			decideSendReview({
				...base,
				sources: [source("A.md")],
				represented: ["A.md"],
			}),
		).toEqual({ required: false, reasons: [] });
	});

	it("fails closed on unrepresented, truncated, quoted or generated material", () => {
		const decision = decideSendReview({
			sources: [
				source("Hidden.md"),
				source("Long.md", "ab", { originalLength: 9 }),
				source("T.md", "x", { quoteKind: "template" }),
			],
			represented: ["Long.md", "T.md"],
			notices: ["Note was truncated."],
			generated: true,
			requested: false,
		});
		expect(decision.required).toBe(true);
		expect(decision.reasons).toEqual([
			"This turn includes generated instructions.",
			"Note was truncated.",
			"Hidden.md is not shown in the composer.",
			"Long.md is truncated to 2 of 9 characters.",
			"T.md is included as template.",
		]);
	});

	it("honours an explicit review request and renamed sources", () => {
		expect(
			decideSendReview({
				...base,
				requested: true,
				sources: [source("Old.md", "x", { currentPath: "New.md" })],
				represented: ["New.md"],
			}).reasons,
		).toEqual(["Review requested."]);
	});
});

const item = (path: string, extra: Partial<ContextItem> = {}): ContextItem => ({
	id: path,
	source: { path, text: "t", capturedAt: 1 },
	role: "reference",
	lifetime: "turn",
	scope: { kind: "note" },
	...extra,
});

describe("composerChips", () => {
	it("shows one follow chip for the active note", () => {
		const view = composerChips({
			items: [item("B.md")],
			activePath: "A.md",
			followDismissed: false,
		});
		expect(view.following).toBe(true);
		expect(view.chips.map((chip) => [chip.kind, chip.path])).toEqual([
			["following", "A.md"],
			["item", "B.md"],
		]);
	});

	it("replaces follow with an explicit item for the same note", () => {
		const view = composerChips({
			items: [item("A.md", { lifetime: "session", role: "working" })],
			activePath: "A.md",
			followDismissed: false,
		});
		expect(view.following).toBe(false);
		expect(view.chips).toHaveLength(1);
		expect(view.chips[0]).toMatchObject({ pinned: true, kind: "item" });
	});

	it("keeps a dismissed follow off and never shows destinations", () => {
		const view = composerChips({
			items: [item("D.md", { role: "destination" })],
			activePath: "A.md",
			followDismissed: true,
		});
		expect(view).toEqual({ chips: [], following: false });
	});
});
