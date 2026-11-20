import type { DataAdapter } from "obsidian";
import type {
	CompanionState,
	ContextScope,
	DestinationAnchor,
	NoteEditProposal,
	TextRange,
	WriteReceipt,
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
	(value.target === undefined ||
		(destination(value.target) && value.target.path === value.path)) &&
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
		(value.compact !== undefined && typeof value.compact !== "boolean") ||
		(value.favourites !== undefined &&
			(!Array.isArray(value.favourites) ||
				!value.favourites.every(str))) ||
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
						typeof item.status === "string" ? item.status : "",
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
						object(item) &&
						scope(item.scope) &&
						(item.quoteKind === undefined ||
							item.quoteKind === "template" ||
							item.quoteKind === "approved-destination") &&
						(item.currentPath === undefined ||
							path(item.currentPath)) &&
						(item.originalLength === undefined ||
							(typeof item.originalLength === "number" &&
								Number.isSafeInteger(item.originalLength) &&
								item.originalLength >= 0)) &&
						source(item),
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
		Array.from(sessionId).some((c) => c.charCodeAt(0) < 32)
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

function isUnresolved(status: WriteReceipt["status"]): boolean {
	return (
		status === "pending" ||
		status === "unknown" ||
		status === "undo-pending"
	);
}

/** One plugin-scoped store; serializes snapshots, receipts and deletion across views. */
export class CompanionStorage {
	private tail: Promise<void> = Promise.resolve();
	private deleted = new Set<string>();
	private listeners = new Set<(state: CompanionState) => void>();
	constructor(
		private adapter: Pick<
			DataAdapter,
			"exists" | "read" | "write" | "mkdir" | "remove" | "list"
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
	private async slots(sessionId: string) {
		const primary = this.file(sessionId);
		const valid: {
			path: string;
			revision: number;
			state: CompanionState;
		}[] = [];
		let torn = false;
		for (const path of [primary, `${primary}.next`]) {
			if (!(await this.adapter.exists(path))) continue;
			const raw = await this.adapter.read(path);
			let record: unknown;
			try {
				record = JSON.parse(raw) as unknown;
			} catch {
				torn = true;
				continue;
			}
			// Never replace a recognized but unsupported schema or identity.
			let revision = 0;
			if (
				typeof record === "object" &&
				record !== null &&
				"revision" in record
			) {
				if (
					typeof record.revision !== "number" ||
					!Number.isSafeInteger(record.revision) ||
					record.revision < 1 ||
					!("state" in record)
				)
					throw new Error("Unsupported companion recovery record");
				revision = record.revision;
				record = record.state;
			}
			assertState(record, sessionId);
			valid.push({ path, revision, state: record });
		}
		if (!valid.length && torn)
			throw new Error(
				"Companion state is damaged and no intact copy is available",
			);
		return valid.sort((a, b) => b.revision - a.revision);
	}
	private async read(sessionId: string): Promise<CompanionState | null> {
		return (await this.slots(sessionId))[0]?.state ?? null;
	}
	private async persist(sessionId: string, state: CompanionState) {
		const [latest] = await this.slots(sessionId);
		const primary = this.file(sessionId);
		const target = latest?.path === primary ? `${primary}.next` : primary;
		const raw = latest
			? JSON.stringify({ revision: latest.revision + 1, state })
			: JSON.stringify(state);
		await this.adapter.write(target, raw);
		if ((await this.adapter.read(target)) !== raw)
			throw new Error("Companion save could not be verified");
	}
	/** Only plugin-owned sidecars are enumerated, never the vault's notes. */
	private async allSessionIds(): Promise<string[]> {
		if (!(await this.adapter.exists(this.directory))) return [];
		const { files } = await this.adapter.list(this.directory);
		const ids = new Set<string>();
		for (const file of files) {
			const hex =
				/(?:^|\/)v1-([0-9a-f]+)\.companion\.json(?:\.next)?$/.exec(
					file,
				)?.[1];
			if (!hex) continue;
			const bytes = Uint8Array.from(hex.match(/../g) ?? [], (char) =>
				Number.parseInt(char, 16),
			);
			const id = new TextDecoder().decode(bytes);
			if (filename(id) !== `v1-${hex}.companion.json`)
				throw new Error("Invalid companion storage identity");
			ids.add(id);
		}
		return [...ids];
	}
	async assertNoUnresolvedWrite(path: string): Promise<void> {
		await this.enqueue(async () => {
			for (const id of await this.allSessionIds()) {
				const state = await this.read(id);
				if (
					state?.operations.some(
						({ proposal, receipt }) =>
							proposal.path.normalize("NFC").toLowerCase() ===
								path.normalize("NFC").toLowerCase() &&
							isUnresolved(receipt.status),
					)
				)
					throw new Error(
						"Reconcile the previous write to this note in its originating conversation first",
					);
			}
		});
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
		onUnconfirmed?: (readback: CompanionState | null | undefined) => void,
	): Promise<CompanionState> {
		return this.enqueue(async () => {
			if (this.deleted.has(sessionId))
				throw new Error("The conversation was deleted");
			const previous =
				(await this.read(sessionId)) ?? emptyCompanion(sessionId);
			const state = change(previous);
			assertState(state, sessionId);
			try {
				if (!onUnconfirmed || state !== previous) {
					if (!(await this.adapter.exists(this.directory)))
						await this.adapter.mkdir(this.directory);
					await this.persist(sessionId, state);
				}
			} catch (error) {
				// Read the durable slot before a queued edit or removal can run.
				// Undefined means readback itself was unavailable.
				if (onUnconfirmed)
					onUnconfirmed(
						await this.read(sessionId).catch(() => undefined),
					);
				throw error;
			}
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
			await this.persist(sessionId, state);
			for (const listener of this.listeners) listener(state);
		});
	}
	remove(sessionId: string): Promise<void> {
		return this.enqueue(async () => {
			const state = await this.read(sessionId);
			if (
				state?.operations.some(({ receipt }) =>
					isUnresolved(receipt.status),
				)
			)
				throw new Error(
					"Reconcile pending note writes before deleting this conversation",
				);
			const file = this.file(sessionId);
			for (const slot of [file, `${file}.next`])
				if (await this.adapter.exists(slot))
					await this.adapter.remove(slot);
			this.deleted.add(sessionId);
		});
	}
}
