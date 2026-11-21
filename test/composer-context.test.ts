import { describe, expect, it } from "vitest";
import {
	decideSendReview,
	representedItems,
} from "../src/services/send-review-policy";
import { prepareContext } from "../src/services/context-builder";
import { composerChips } from "../src/services/companion-presentation";
import type { ContextItem } from "../src/types/note-companion";

const source = (
	path: string,
	text = "body",
	extra: Partial<ReturnType<typeof prepareContext>["sources"][number]> = {},
) => ({
	path,
	text,
	capturedAt: 1,
	scope: { kind: "note" as const },
	originalLength: text.length,
	provenance: "mention" as const,
	...extra,
});
const base = { notices: [], generated: false, requested: false };

describe("decideSendReview", () => {
	it("does not let an exact visible passage authorize a whole note at the same path", () => {
		const passage = source("A.md", "public", {
			scope: { kind: "passage", range: { start: 0, end: 6 } },
			itemId: "passage",
			provenance: "captured",
		});
		const represented = representedItems([
			item("A.md", {
				id: "passage",
				scope: passage.scope,
				source: {
					path: "A.md",
					text: "public + private",
					capturedAt: 1,
				},
			}),
		]);
		expect(
			decideSendReview({ ...base, sources: [passage], represented })
				.required,
		).toBe(false);
		expect(
			decideSendReview({
				...base,
				sources: [passage, source("A.md", "public + private")],
				represented,
			}).required,
		).toBe(true);
	});
	it("sends a fully represented ordinary turn without review", () => {
		expect(
			decideSendReview({
				...base,
				sources: [source("A.md")],
				represented: [{ ...source("A.md"), provenance: "mention" }],
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
			represented: [
				{ ...source("Long.md", "ab"), provenance: "mention" },
			],
			notices: ["Note was truncated."],
			generated: true,
			requested: false,
		});
		expect(decision.required).toBe(true);
		expect(decision.reasons).toEqual([
			"This turn includes generated instructions.",
			"Note was truncated.",
			"Hidden.md (note) does not match an exact source shown in the composer.",
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
				represented: [
					{ ...source("Old.md", "x"), provenance: "mention" },
				],
			}).reasons,
		).toEqual(["Review requested.", "Old.md was renamed to New.md."]);
	});

	it("matches separate same-path captures one-to-one, and never a destination", () => {
		const items = [
			item("A.md", {
				id: "p",
				scope: { kind: "passage", range: { start: 0, end: 1 } },
			}),
			item("A.md", { id: "pin", lifetime: "session" }),
			item("D.md", { role: "destination" }),
		];
		const { sources, excludedPaths } = prepareContext(items, {
			embeddedContext: true,
			maxNoteLength: 100,
			maxSelectionLength: 100,
		});
		const represented = representedItems(items);
		const decide = (...actual: typeof sources) =>
			decideSendReview({ ...base, sources: actual, represented })
				.required;
		expect(excludedPaths).toContain("D.md");
		expect(sources).toHaveLength(2);
		expect(decide(...sources)).toBe(false);
		expect(decide(sources[0], sources[0])).toBe(true);
		expect(decide(sources[0], { ...sources[1], text: "changed" })).toBe(
			true,
		);
		expect(
			decide(sources[0], { ...sources[1], provenance: "mention" }),
		).toBe(true);
		expect(decide(source("D.md", "t"))).toBe(true);
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
