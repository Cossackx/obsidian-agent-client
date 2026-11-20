import type { DataAdapter } from "obsidian";
import type {
	CompanionState,
	ContextScope,
	DestinationAnchor,
	NoteEditProposal,
	TextRange,
} from "../types/note-companion";
import { isNotePath } from "./context-builder";
import { emptyCompanion } from "./companion-state";

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const path = (value: unknown): value is string =>
	typeof value === "string" && isNotePath(value);
const str = (value: unknown): value is string => typeof value === "string";
const time = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);
const occurrence = (value: unknown) =>
	Number.isSafeInteger(value) && Number(value) > 0;
const range = (value: unknown, length = Infinity): value is TextRange =>
	object(value) &&
	Number.isSafeInteger(value.start) &&
	Number.isSafeInteger(value.end) &&
	Number(value.start) >= 0 &&
	Number(value.start) <= Number(value.end) &&
	Number(value.end) <= length;
const scope = (value: unknown, length?: number): value is ContextScope =>
	object(value) &&
	(value.kind === "note" ||
		(range(value.range, length) &&
			(value.kind === "passage" ||
				(value.kind === "heading" &&
					str(value.heading) &&
					occurrence(value.occurrence)))));
const destination = (value: unknown): value is DestinationAnchor =>
	object(value) &&
	path(value.path) &&
	(value.kind === "end" ||
		(value.kind === "range" && range(value.range)) ||
		(value.kind === "heading" &&
			str(value.heading) &&
			occurrence(value.occurrence)));
export const proposalIsValid = (value: unknown): value is NoteEditProposal =>
	object(value) &&
	str(value.id) &&
	value.id.length > 0 &&
	path(value.path) &&
	str(value.after) &&
	str(value.sourceMessageId) &&
	(value.mode === "create"
		? value.before === null
		: ["append", "insert", "replace"].includes(String(value.mode)) &&
			str(value.before)) &&
	value.before !== value.after;
const statuses = [
	"pending",
	"verified",
	"not-applied",
	"conflict",
	"unknown",
	"undo-pending",
	"undone",
];
const receipt = (value: unknown, proposal: NoteEditProposal) =>
	object(value) &&
	value.operationId === proposal.id &&
	value.path === proposal.path &&
	statuses.includes(String(value.status));
const source = (
	value: unknown,
): value is CompanionState["items"][number]["source"] =>
	object(value) &&
	path(value.path) &&
	str(value.text) &&
	time(value.capturedAt);
function assertState(
	value: unknown,
	id: string,
): asserts value is CompanionState {
	if (!object(value) || value.version !== 1)
		throw new Error(
			"Unsupported companion data version; existing file preserved",
		);
	if (
		value.sessionId !== id ||
		!str(value.draft) ||
		!(value.destination === null || destination(value.destination)) ||
		!Array.isArray(value.items) ||
		!value.items.every(
			(item: unknown) =>
				object(item) &&
				str(item.id) &&
				source(item.source) &&
				scope(item.scope, item.source.text.length) &&
				["working", "reference", "destination"].includes(
					String(item.role),
				) &&
				["turn", "session"].includes(String(item.lifetime)) &&
				(item.annotation === undefined || str(item.annotation)) &&
				(item.status === undefined ||
					["changed", "missing", "renamed"].includes(
						String(item.status),
					)),
		) ||
		!Array.isArray(value.operations) ||
		!value.operations.every(
			(entry: unknown) =>
				object(entry) &&
				proposalIsValid(entry.proposal) &&
				receipt(entry.receipt, entry.proposal),
		) ||
		!Array.isArray(value.sent) ||
		!value.sent.every(
			(turn: unknown) =>
				object(turn) &&
				str(turn.id) &&
				Array.isArray(turn.sources) &&
				turn.sources.every(
					(item: unknown) =>
						object(item) && source(item) && scope(item.scope),
				),
		)
	) {
		throw new Error("Invalid companion data; existing file preserved");
	}
}

export function companionDirectory(configDir: string): string {
	return `${configDir}/plugins/agent-client/sessions`;
}

function filename(sessionId: string): string {
	if (
		!sessionId ||
		sessionId.length > 96 ||
		/[\u0000-\u001f]/.test(sessionId)
	)
		throw new Error("Invalid companion session ID");
	const bytes = new TextEncoder().encode(sessionId);
	const encoded = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	if (encoded.length > 192 || new TextDecoder().decode(bytes) !== sessionId)
		throw new Error("Invalid companion session ID");
	return `v1-${encoded}.companion.json`;
}

/** One plugin-scoped store; serializes snapshots, receipts and deletion across views. */
export class CompanionStorage {
	private tail: Promise<void> = Promise.resolve();
	private deleted = new Set<string>();
	private listeners = new Set<(state: CompanionState) => void>();
	constructor(
		private adapter: Pick<
			DataAdapter,
			"exists" | "read" | "write" | "mkdir" | "remove"
		>,
		private directory: string,
	) {}
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.then(work);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	private file(sessionId: string): string {
		return `${this.directory}/${filename(sessionId)}`;
	}
	private async read(sessionId: string): Promise<CompanionState | null> {
		const file = this.file(sessionId);
		if (!(await this.adapter.exists(file))) return null;
		const value: unknown = JSON.parse(await this.adapter.read(file));
		assertState(value, sessionId);
		return value;
	}
	load(sessionId: string): Promise<CompanionState | null> {
		return this.enqueue(() => this.read(sessionId));
	}
	subscribe(listener: (state: CompanionState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async save(state: CompanionState): Promise<void> {
		const snapshot = structuredClone(state);
		await this.update(snapshot.sessionId, () => snapshot);
	}
	update(
		sessionId: string,
		change: (state: CompanionState) => CompanionState,
	): Promise<CompanionState> {
		return this.enqueue(async () => {
			if (this.deleted.has(sessionId))
				throw new Error("The conversation was deleted");
			const state = change(
				(await this.read(sessionId)) ?? emptyCompanion(sessionId),
			);
			assertState(state, sessionId);
			if (!(await this.adapter.exists(this.directory)))
				await this.adapter.mkdir(this.directory);
			await this.adapter.write(
				this.file(sessionId),
				JSON.stringify(state),
			);
			for (const listener of this.listeners) listener(state);
			return state;
		});
	}
	updateExisting(
		sessionId: string,
		change: (state: CompanionState) => CompanionState,
	): Promise<void> {
		return this.enqueue(async () => {
			if (this.deleted.has(sessionId)) return;
			const previous = await this.read(sessionId);
			if (!previous) return;
			const state = change(previous);
			if (state === previous) return;
			assertState(state, sessionId);
			await this.adapter.write(
				this.file(sessionId),
				JSON.stringify(state),
			);
			for (const listener of this.listeners) listener(state);
		});
	}
	remove(sessionId: string): Promise<void> {
		return this.enqueue(async () => {
			const file = this.file(sessionId);
			if (await this.adapter.exists(file))
				await this.adapter.remove(file);
			this.deleted.add(sessionId);
		});
	}
}
