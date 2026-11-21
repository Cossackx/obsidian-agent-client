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
} from "../src/services/companion-state";
import { CompanionStorage } from "../src/services/companion-storage";
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

import { guardCompanionChange } from "../src/services/companion-mutation";
import {
	decideSendReview,
	representedItems,
} from "../src/services/send-review-policy";
import { insertReply } from "../src/services/reply-note-action";
const path = "Fixture.md",
	before = "A\r\n";
const proposal = () =>
	planLiteralEdit(
		{ path, text: before, capturedAt: 1 },
		{ kind: "end", path },
		"TEXT",
		"append",
		"reply-A",
	);
const base = { notices: [], generated: false, requested: false };
function latch() {
	let go!: () => void;
	const p = new Promise<void>((r) => (go = r));
	return { go, p };
}

it.each([true, false])(
	"X6 Atomic callback accepted, process rejects, unchanged witness: applied=%s",
	async (applied) => {
		const a = actionsFixture(),
			p = proposal();
		let own = true;
		a.vault.process.mockImplementationOnce(async (_, fn) => {
			const next = fn(a.text());
			if (applied) a.edit(next);
			own = false;
			throw Error("ack unavailable");
		});
		const start = await a.service.apply("A", p, () => own);
		expect(start.status).toBe("unknown");
		const reads = a.vault.read.mock.calls.length;
		const r = await a.restart().reconcile("A", p.id);
		const obs = {
			status: r.status,
			lost: r.targetLost ?? false,
			reads: a.vault.read.mock.calls.length - reads,
			writes: a.vault.process.mock.calls.length,
			actual: a.text(),
		};
		console.log("X6", applied, obs);
		expect(await a.storage.load("B")).toBeNull();
		expect(obs).toMatchObject({
			status: applied ? "verified" : "not-applied",
			lost: false,
			reads: 1,
			writes: 1,
		});
	},
);
it.each(["same", "new"])(
	"X7 readback failed after Apply then rebuild %s vault",
	async (mode) => {
		const a = actionsFixture(),
			p = proposal();
		a.vault.read.mockRejectedValueOnce(Error("readback"));
		expect((await a.service.apply("A", p)).status).toBe("unknown");
		const s =
			mode === "same"
				? a.restart()
				: new NoteActionService({ ...a.vault } as never, a.storage);
		const r = await s.reconcile("A", p.id);
		expect(r.status).toBe(mode === "same" ? "verified" : "conflict");
		expect(a.vault.process).toHaveBeenCalledTimes(1);
		await s.undo("A", p.id);
		expect(a.text()).toBe(mode === "same" ? p.before : p.after);
	},
);
it("X8 issued Undo with owner loss and missing acknowledgement reconciles without a second write", async () => {
	const a = actionsFixture(),
		p = proposal();
	await a.service.apply("A", p);
	let own = true;
	a.vault.process.mockImplementationOnce(async (_, f) => {
		a.edit(f(a.text()));
		own = false;
		throw Error("no ack");
	});
	expect((await a.service.undo("A", p.id, () => own)).status).toBe(
		"undo-pending",
	);
	expect((await a.restart().reconcile("A", p.id)).status).toBe("undone");
	expect(a.text()).toBe(before);
	expect(a.vault.process).toHaveBeenCalledTimes(2);
	expect(await a.storage.load("B")).toBeNull();
});
