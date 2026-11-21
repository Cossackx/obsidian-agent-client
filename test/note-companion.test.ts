import { expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import {
	contextText,
	headingRanges,
	prepareContext,
} from "../src/services/context-builder";
import {
	consumeSubmittedItems,
	emptyCompanion,
	moveItem,
	removeItem,
} from "../src/services/companion-state";
import { CompanionStorage } from "../src/services/companion-storage";
import { guardCompanionChange } from "../src/services/companion-mutation";
import { NoteActionService } from "../src/services/note-action-service";
import {
	describeNoteTarget,
	planLiteralEdit,
} from "../src/services/note-edit-planner";
import {
	createRevisionProposal,
	parseStructuredReply,
	validatePassageRevisions,
} from "../src/services/passage-review";
import { validateCaptureProposal } from "../src/services/capture-proposal";
import { compareSource } from "../src/services/source-comparison";
import {
	findNoteSessions,
	renameNoteAssociation,
} from "../src/services/note-session-index";
import { buildSynthesisPrompt } from "../src/services/synthesis-request";
import { deriveCompanionStatus } from "../src/services/companion-presentation";
import {
	preparePrompt,
	sendPreparedPrompt,
} from "../src/services/message-sender";
import type { ContextItem } from "../src/types/note-companion";

const directory = "fixture-config/plugins/agent-client/sessions";
function fixture() {
	const files = new Map<string, string>();
	const adapter = {
		list: vi.fn(async (path: string) => ({
			files: [...files.keys()].filter((name) =>
				name.startsWith(`${path}/`),
			),
			folders: [],
		})),
		exists: vi.fn(async (path: string) => files.has(path)),
		read: vi.fn(async (path: string) => files.get(path)!),
		write: vi.fn(async (path: string, data: string) => {
			files.set(path, data);
		}),
		mkdir: vi.fn(async (path: string) => {
			files.set(path, "");
		}),
		remove: vi.fn(async (path: string) => {
			files.delete(path);
		}),
	};
	return {
		storage: new CompanionStorage(adapter, directory),
		adapter,
		files,
	};
}
const item = (path: string, text: string, id = path): ContextItem => ({
	id,
	role: "reference",
	lifetime: "turn",
	scope: { kind: "note" },
	source: { path, text, capturedAt: 42 },
});
const limits = {
	embeddedContext: true,
	maxNoteLength: 100,
	maxSelectionLength: 100,
};

it("rechecks the original lease after the recovery slot lookup but before issuing a write", async () => {
	const { adapter, storage } = fixture();
	let owns = true,
		transformed = false;
	const exists = adapter.exists.getMockImplementation()!;
	adapter.exists.mockImplementation(async (path) => {
		if (transformed && path.endsWith(".next")) owns = false;
		return exists(path);
	});
	await expect(
		storage.update(
			"A",
			guardCompanionChange(
				() => owns,
				(old) => {
					transformed = true;
					return {
						...old,
						items: [item("Draft.md", "Expired passage")],
					};
				},
			),
		),
	).rejects.toThrow("Conversation changed");
	expect(adapter.write).not.toHaveBeenCalled();
	expect(await storage.load("A")).toBeNull();
});

it("preview_blocks_are_the_sent_blocks and destination-only bodies are excluded", async () => {
	const selected = item("a/Same.md", "before 🐙\r\nTARGET after");
	selected.scope = { kind: "passage", range: { start: 7, end: 17 } };
	const dest = {
		...item("b/Same.md", "DO NOT TRANSMIT"),
		role: "destination" as const,
	};
	const prepared = prepareContext([selected, dest], limits);
	const draft = {
		message: "Discuss",
		vaultBasePath: "/synthetic",
		supportsEmbeddedContext: true,
		preparedContext: prepared,
		activeNote: {
			path: dest.source.path,
			name: "Same",
			extension: "md",
			created: 0,
			modified: 0,
		},
	};
	selected.source.text = "different bytes";
	const readNote = vi.fn();
	const outbound = await preparePrompt(
		draft,
		{ readNote } as never,
		{} as never,
	);
	const sendPrompt = vi.fn();
	await sendPreparedPrompt(
		{
			sessionId: "fixture",
			...outbound,
			authMethods: [],
			strictCompletion: true,
		},
		{ sendPrompt } as never,
	);
	expect(sendPrompt).toHaveBeenCalledWith(
		"fixture",
		outbound.agentContent,
		true,
	);
	expect(outbound.agentContent.slice(-prepared.blocks.length)).toEqual(
		prepared.blocks,
	);
	expect(outbound.agentContent).toContainEqual(
		matching({
			resource: matching({ text: "🐙\r\nTARGET" }),
		}),
	);
	expect(JSON.stringify(outbound.agentContent)).not.toMatch(
		/DO NOT TRANSMIT|different bytes|b\/Same\.md/,
	);
	expect(readNote).not.toHaveBeenCalled();
});
it("keeps source paths and annotated passages distinct, with visible truncation", () => {
	const a = { ...item("a/Same.md", "🐙TEXT"), status: "missing" as const };
	const b = item("b/Same.md", "Other");
	const prepared = prepareContext(
		[
			a,
			b,
			{ ...a, id: "duplicate" },
			{ ...a, id: "different", annotation: "discuss" },
		],
		{ ...limits, maxNoteLength: 1 },
	);
	expect(prepared.sources.map(({ path, text }) => [path, text])).toEqual([
		[a.source.path, ""],
		[b.source.path, "O"],
		[a.source.path, ""],
	]);
	expect(prepared.notices.some((note) => note.includes("missing"))).toBe(
		true,
	);
	expect(prepared.notices.some((note) => note.includes("truncated"))).toBe(
		true,
	);
	expect(buildSynthesisPrompt([a, b], "contradictions")).toContain(
		'"path":"b/Same.md"',
	);
	expect(buildSynthesisPrompt([a, b], "contradictions")).not.toContain(
		"🐙TEXT",
	);
});
it("reorders context and consumes only the confirmed one-turn items", () => {
	const a = item("a.md", "a");
	const b = { ...item("b.md", "b"), lifetime: "session" as const };
	const state = {
		...emptyCompanion("fixture"),
		items: [a, b],
		draft: "stay",
	};
	expect(moveItem(state, b.id, -1).items).toEqual([b, a]);
	expect(consumeSubmittedItems(state, []).items).toEqual([a, b]);
	expect(consumeSubmittedItems(state, [a.id, b.id])).toMatchObject({
		items: [b],
		draft: "stay",
	});
});
it("preserves unknown sidecars, isolates drafts and recovers a failed save", async () => {
	const { storage, adapter, files } = fixture();
	await expect(storage.load("legacy")).resolves.toBeNull();
	const a = { ...emptyCompanion("../A"), draft: "Draft A" };
	const b = { ...emptyCompanion("../a"), draft: "Draft B" };
	adapter.write.mockRejectedValueOnce(new Error("synthetic write failure"));
	await expect(storage.save(a)).rejects.toThrow("synthetic write failure");
	await Promise.all([storage.save(a), storage.save(b)]);
	expect(await storage.load(a.sessionId)).toEqual(a);
	expect(await storage.load(b.sessionId)).toEqual(b);
	const paths = [...files.keys()].filter((path) =>
		path.endsWith(".companion.json"),
	);
	expect(paths).toHaveLength(2);
	expect(
		paths.every(
			(path) => path.startsWith(`${directory}/`) && !path.includes(".."),
		),
	).toBe(true);
	for (const path of paths) files.set(path, '{"version":2}');
	await expect(storage.save(a)).rejects.toThrow(/unsupported/i);
	expect(paths.every((path) => files.get(path) === '{"version":2}')).toBe(
		true,
	);
});
const path = "Fixture.md";
const before =
	"---\r\ntitle: fixture\r\n---\r\n# Team\r\nFirst\r\n# Team\r\nSecond\r\n# Next\r\nThird\r\n";
function proposal() {
	return planLiteralEdit(
		{ path, text: before, capturedAt: 0 },
		{ path, kind: "heading", heading: "Team", occurrence: 2 },
		"Added 🐙",
		"append",
		"reply",
	);
}
it("uses exact heading occurrence, preserves preimage line endings and rejects invalid edits", () => {
	expect(headingRanges(before)).toHaveLength(3);
	expect(proposal().after).toBe(
		before.replace("Second\r\n", "Second\r\nAdded 🐙\r\n"),
	);
	const source = { path, text: "left TARGET right", capturedAt: 1 };
	const target = {
		kind: "range" as const,
		path,
		range: { start: 5, end: 11 },
	};
	expect(planLiteralEdit(source, target, "🐙", "replace", "msg").after).toBe(
		"left 🐙 right",
	);
	expect(planLiteralEdit(source, target, "🐙", "insert", "msg").after).toBe(
		"left 🐙TARGET right",
	);
	expect(() =>
		planLiteralEdit(
			source,
			{ ...target, path: "../bad.md" },
			"x",
			"replace",
			"msg",
		),
	).toThrow();
	expect(() =>
		planLiteralEdit(source, target, " ", "replace", "msg"),
	).toThrow();
});
function actionsFixture() {
	const { storage, adapter, files } = fixture();
	const note = new TFile(path, "Fixture");
	let text = before;
	const vault = {
		getAbstractFileByPath: vi.fn(() => note),
		read: vi.fn(async () => text),
		process: vi.fn(
			async (_note: TFile, change: (text: string) => string) => {
				text = change(text);
				return text;
			},
		),
		create: vi.fn(),
		trash: vi.fn(),
	};
	return {
		storage,
		adapter,
		vault,
		service: new NoteActionService(vault, storage),
		files,
		restart: () =>
			new NoteActionService(
				vault,
				new CompanionStorage(adapter, directory),
			),
		text: () => text,
		edit: (next: string) => {
			text = next;
		},
	};
}
it("persists the approved heading occurrence and reply in the write receipt", async () => {
	const { service, storage } = actionsFixture();
	const planned = proposal();
	const completed = await service.apply("session-a", planned);
	expect(completed.status).toBe("verified");
	const row = (await storage.load("session-a"))?.operations[0];
	expect(row?.proposal).toMatchObject({
		target: planned.target,
		sourceMessageId: "reply",
	});
	expect(describeNoteTarget(row!.proposal)).toBe(
		`${path} > Team (occurrence 2)`,
	);
});
it("duplicate_operation_writes_once and stale undo preserves intervening edits", async () => {
	const { service, vault, text, edit } = actionsFixture();
	const plan = proposal();
	const both = await Promise.all([
		service.apply("s", plan),
		service.apply("s", plan),
	]);
	expect(both.map((r) => r.status)).toEqual(["verified", "verified"]);
	expect(vault.process).toHaveBeenCalledTimes(1);
	edit(`${text()}Intervening edit`);
	const kept = text();
	expect((await service.undo("s", plan.id)).status).toBe("conflict");
	expect(text()).toBe(kept);
});
it("stale_preimage_is_conflict, and no pending receipt means no mutation", async () => {
	const { service, adapter, vault, edit, text } = actionsFixture();
	adapter.write.mockRejectedValueOnce(new Error("receipt could not save"));
	await expect(service.apply("s", proposal())).rejects.toThrow(
		"receipt could not save",
	);
	expect(vault.process).not.toHaveBeenCalled();
	edit("Changed before clicking Apply");
	expect((await service.apply("s", proposal())).status).toBe("conflict");
	expect(text()).toBe("Changed before clicking Apply");
});
it("write_then_read_failure_is_unknown_effect; reconciliation never retries", async () => {
	const { service, vault, text } = actionsFixture();
	const plan = proposal();
	vault.read.mockRejectedValueOnce(new Error("readback failed"));
	expect((await service.apply("s", plan)).status).toBe("unknown");
	expect((await service.reconcile("s", plan.id)).status).toBe("verified");
	expect(vault.process).toHaveBeenCalledTimes(1);
	expect((await service.undo("s", plan.id)).status).toBe("undone");
	expect(text()).toBe(before);
});
it("overlapping revisions cannot both apply; a mismatched or malformed result has no proposal", async () => {
	const { service, text } = actionsFixture();
	const source = item(path, before, "requested");
	source.scope = {
		kind: "passage",
		range: {
			start: before.indexOf("Second"),
			end: before.indexOf("Second") + 6,
		},
	};
	const r = {
		itemId: source.id,
		original: "Second",
		replacement: "Alternate",
	};
	expect(contextText(source)).toBe("Second");
	expect(() =>
		validatePassageRevisions([{ ...r, itemId: "forged" }], [source]),
	).toThrow();
	expect(() =>
		validatePassageRevisions([{ ...r, original: "wrong" }], [source]),
	).toThrow();
	expect(() =>
		parseStructuredReply('chat prose [{"itemId":"requested"}]'),
	).toThrow();
	const first = createRevisionProposal(r, source, "reply");
	const second = createRevisionProposal(
		{ ...r, replacement: "Other" },
		source,
		"reply",
	);
	expect((await service.apply("s", first)).status).toBe("verified");
	expect((await service.apply("s", second)).status).toBe("conflict");
	expect(text()).toContain("Alternate");
});
it("editorial output stays within the approved heading and cannot overwrite a new-note collision", async () => {
	const { service, vault } = actionsFixture();
	const target = {
		kind: "heading" as const,
		path,
		heading: "Team",
		occurrence: 2,
	};
	const captured = { path, text: before, capturedAt: 0 };
	const plan = validateCaptureProposal(
		{ path, markdown: "Editorial rationale" },
		"decision",
		target,
		captured,
		"reply",
	);
	expect(plan.after).toBe(before.replace("Second", "Editorial rationale"));
	expect(() =>
		validateCaptureProposal(
			{ path: "Elsewhere.md", markdown: "x" },
			"decision",
			target,
			captured,
			"reply",
		),
	).toThrow();
	const create = validateCaptureProposal(
		{ path, markdown: "Not an overwrite" },
		"new-note",
		{ kind: "end", path },
		null,
		"reply",
	);
	expect((await service.apply("s", create)).status).toBe("conflict");
	expect(vault.create).not.toHaveBeenCalled();
});
it("rename updates exact note associations; comparison uses only the saved sent excerpt", async () => {
	const { storage } = fixture();
	const a = item("a/Same.md", "before");
	const b = item("b/Same.md", "other");
	const prepared = prepareContext([a, b], { ...limits, maxNoteLength: 3 });
	const state = {
		...emptyCompanion("s"),
		items: [a, b],
		sent: [{ id: "turn", sources: prepared.sources }],
	};
	await storage.save(
		renameNoteAssociation(state, "a/Same.md", "x/Renamed.md"),
	);
	const row = {
		sessionId: "s",
		cwd: "/synthetic",
		agentId: "fixture",
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	};
	const found = await findNoteSessions("x/Renamed.md", [row], storage);
	expect(found).toHaveLength(1);
	expect(await findNoteSessions("a/Same.md", [row], storage)).toHaveLength(0);
	expect(await findNoteSessions("b/Same.md", [row], storage)).toHaveLength(1);
	expect(
		compareSource(found[0].companion.sent[0].sources[0], {
			path: "x/Renamed.md",
			text: "after",
			capturedAt: 2,
		}),
	).toEqual({ changed: true, before: "bef", after: "aft", truncated: true });
});
it("history_is_not_connection; authorization prompts and failures are distinct", () => {
	const state = {
		connected: false,
		busy: false,
		pendingPermission: false,
		hasHistory: true,
		initializing: false,
	};
	expect(deriveCompanionStatus(state)).toBe("history-only");
	expect(deriveCompanionStatus({ ...state, error: "failed" })).toBe("error");
	expect(
		deriveCompanionStatus({
			...state,
			pendingPermission: true,
			error: "failed",
		}),
	).toBe("needs-approval");
});

function matching(fields: Record<string, unknown>): unknown {
	return expect.objectContaining(fields) as unknown;
}

it("blocks a different conversation after restart while an apply is unresolved", async () => {
	const { service, restart, vault } = actionsFixture();
	const first = proposal();
	vault.read.mockRejectedValueOnce(new Error("Lost first readback"));
	expect((await service.apply("a", first)).status).toBe("unknown");
	const second = {
		...first,
		id: "new-operation",
		before: first.after,
		after: first.after + "Second\r\n",
	};
	await expect(restart().apply("b", second)).rejects.toThrow(/reconcile/i);
	expect(vault.process).toHaveBeenCalledTimes(1);
	expect((await restart().reconcile("a", first.id)).status).toBe("verified");
	expect((await restart().apply("b", second)).status).toBe("verified");
});
it("recovers an intact pending receipt when the final save tears after changing the note", async () => {
	const { service, restart, adapter, files, text, vault } = actionsFixture();
	const first = proposal();
	adapter.write.mockImplementationOnce(async (key, value) => {
		files.set(key, value);
	});
	adapter.write.mockImplementationOnce(async (key) => {
		files.set(key, "{");
		throw new Error("Short write");
	});
	await expect(service.apply("a", first)).rejects.toThrow("Short write");
	expect(text()).toBe(first.after);
	expect((await restart().reconcile("a", first.id)).status).toBe("verified");
	expect(vault.process).toHaveBeenCalledTimes(1);
});
it("makes no note mutation if the pending journal tears", async () => {
	const { service, adapter, files, vault } = actionsFixture();
	adapter.write.mockImplementationOnce(async (key) => {
		files.set(key, "{");
		throw new Error("Short write");
	});
	await expect(service.apply("a", proposal())).rejects.toThrow("Short write");
	expect(vault.process).not.toHaveBeenCalled();
});

it("binds Undo to the written file, not its path or bytes, across service rebuilds", async () => {
	const fx = actionsFixture();
	const note = fx.vault.getAbstractFileByPath() as TFile & { stat?: unknown };
	note.stat = { ctime: 7, mtime: 0, size: 1 };
	const plan = proposal();
	expect((await fx.service.apply("s", plan)).status).toBe("verified");
	// Same path, identical bytes, different file: Undo must not touch it.
	const other = Object.assign(new TFile(path, "Fixture"), {
		stat: { ctime: 8, mtime: 0, size: 1 },
	});
	fx.vault.getAbstractFileByPath.mockReturnValue(other);
	await expect(fx.service.undo("s", plan.id)).rejects.toThrow(
		/moved or replaced/,
	);
	await expect(fx.restart().undo("s", plan.id)).rejects.toThrow(
		/moved or replaced/,
	);
	expect(fx.text()).toBe(plan.after);
	// The original file back in place keeps ordinary Undo working, also after a rebuild.
	fx.vault.getAbstractFileByPath.mockReturnValue(note);
	expect((await fx.restart().undo("s", plan.id)).status).toBe("undone");
	expect(fx.text()).toBe(before);
});

it("rejects a write when the offered target is replaced before the atomic write", async () => {
	const fx = actionsFixture();
	let offered = true;
	const receipt = await fx.service.apply("s", proposal(), () => offered);
	expect(receipt.status).toBe("verified");
	const second = planLiteralEdit(
		{ path, text: fx.text(), capturedAt: 0 },
		{ path, kind: "end" },
		"Later",
		"append",
		"reply-2",
	);
	fx.vault.process.mockImplementationOnce(async (_n, change) => {
		offered = false;
		return change(fx.text());
	});
	expect(
		(await fx.service.apply("s", second, () => offered)).status,
	).not.toBe("verified");
	expect(fx.text()).toBe(proposal().after);
});

it("removing the last followed item durably dismisses the follow; distinct items survive", () => {
	const state = {
		...emptyCompanion("s"),
		items: [
			item("A.md", "a", "1"),
			item("A.md", "b", "2"),
			item("B.md", "c", "3"),
		],
	};
	const once = removeItem(state, "1", "A.md");
	expect(once.followDismissed).toBeFalsy();
	expect(once.items.map((row) => row.id)).toEqual(["2", "3"]);
	expect(removeItem(once, "2", "A.md").followDismissed).toBe(true);
	expect(removeItem(state, "3", "A.md").followDismissed).toBeFalsy();
});
