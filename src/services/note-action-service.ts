import { TFile, type Vault } from "obsidian";
import type { NoteEditProposal, WriteReceipt } from "../types/note-companion";
import { CompanionStorage, proposalIsValid } from "./companion-storage";

class Conflict extends Error {}
class OwnerCancelled extends Conflict {}

/** Shared per vault so two conversations cannot race the same path. */
export class NoteActionService {
	private queues = new Map<string, Promise<void>>();
	constructor(
		private vault: Pick<
			Vault,
			"getAbstractFileByPath" | "read" | "process" | "create"
		>,
		private storage: CompanionStorage,
		private canWrite: (path: string, preimage: string) => boolean = () =>
			true,
	) {}

	private enqueue<T>(path: string, work: () => Promise<T>): Promise<T> {
		path = path.normalize("NFC").toLowerCase();
		const result = (this.queues.get(path) ?? Promise.resolve()).then(work);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(path, tail);
		void tail.then(() => {
			if (this.queues.get(path) === tail) this.queues.delete(path);
		});
		return result;
	}
	private async record(
		sessionId: string,
		proposal: NoteEditProposal,
		status: WriteReceipt["status"],
	): Promise<WriteReceipt> {
		const receipt = {
			operationId: proposal.id,
			path: proposal.path,
			status,
		};
		await this.storage.update(sessionId, (state) => ({
			...state,
			operations: [
				...state.operations.filter(
					(row) => row.proposal.id !== proposal.id,
				),
				{ proposal, receipt },
			],
		}));
		return receipt;
	}
	private async read(path: string): Promise<string | null> {
		const file = this.vault.getAbstractFileByPath(path);
		if (file === null) return null;
		if (!(file instanceof TFile) || file.path !== path)
			throw new Conflict("Destination identity changed");
		return this.vault.read(file);
	}
	private async replace(
		path: string,
		before: string,
		after: string,
		owns: () => boolean,
	): Promise<TFile> {
		if (!owns())
			throw new OwnerCancelled("The originating conversation changed");
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.path !== path)
			throw new Conflict("Destination is missing or changed");
		if (typeof this.vault.process !== "function")
			throw new Conflict("Atomic note editing is unavailable");
		await this.vault.process(file, (current) => {
			if (!owns())
				throw new OwnerCancelled(
					"The originating conversation changed",
				);
			if (!this.canWrite(path, before))
				throw new Conflict("Unsaved changes in the destination editor");
			if (
				file.path !== path ||
				this.vault.getAbstractFileByPath(path) !== file ||
				current !== before
			)
				throw new Conflict("The destination changed after preview");
			return after;
		});
		return file;
	}
	private async verified(file: TFile, path: string, expected: string) {
		return (
			(await this.vault.read(file)) === expected &&
			file.path === path &&
			this.vault.getAbstractFileByPath(path) === file
		);
	}
	apply(
		sessionId: string,
		proposal: NoteEditProposal,
		owns = () => true,
	): Promise<WriteReceipt> {
		if (!proposalIsValid(proposal))
			return Promise.reject(new Error("Invalid note proposal"));
		const frozen = structuredClone(proposal);
		return this.enqueue(frozen.path, async () => {
			const history =
				(await this.storage.load(sessionId))?.operations ?? [];
			const previous = history.find(
				(row) => row.proposal.id === frozen.id,
			);
			if (previous) {
				if (
					previous.proposal.path !== frozen.path ||
					previous.proposal.before !== frozen.before ||
					previous.proposal.after !== frozen.after
				)
					throw new Error(
						"Operation ID refers to a different change",
					);
				return previous.receipt;
			}
			await this.storage.assertNoUnresolvedWrite(frozen.path);
			if (!owns())
				throw new Conflict("The originating conversation changed");
			await this.record(sessionId, frozen, "pending");
			let status: WriteReceipt["status"];
			try {
				if (!owns())
					throw new Conflict("The originating conversation changed");
				let file: TFile;
				if (frozen.before === null) {
					if (this.vault.getAbstractFileByPath(frozen.path))
						throw new Conflict("The new note already exists");
					file = await this.vault.create(frozen.path, frozen.after);
				} else
					file = await this.replace(
						frozen.path,
						frozen.before,
						frozen.after,
						owns,
					);
				status = (await this.verified(file, frozen.path, frozen.after))
					? "verified"
					: "unknown";
			} catch (error) {
				status = error instanceof Conflict ? "conflict" : "unknown";
			}
			return this.record(sessionId, frozen, status);
		});
	}
	async reconcile(sessionId: string, id: string): Promise<WriteReceipt> {
		const entry = (await this.storage.load(sessionId))?.operations.find(
			(row) => row.proposal.id === id,
		);
		if (!entry) throw new Error("Operation was not recorded");
		return this.enqueue(entry.proposal.path, async () => {
			const current = (
				await this.storage.load(sessionId)
			)?.operations.find((row) => row.proposal.id === id);
			if (!current) throw new Error("Operation was removed");
			const { proposal, receipt } = current;
			if (
				!["pending", "unknown", "undo-pending"].includes(receipt.status)
			)
				return receipt;
			const text = await this.read(proposal.path);
			return this.record(
				sessionId,
				proposal,
				text === proposal.after
					? "verified"
					: text === proposal.before
						? receipt.status === "undo-pending"
							? "undone"
							: "not-applied"
						: "conflict",
			);
		});
	}
	async undo(
		sessionId: string,
		id: string,
		owns = () => true,
	): Promise<WriteReceipt> {
		const entry = (await this.storage.load(sessionId))?.operations.find(
			(row) => row.proposal.id === id,
		);
		if (!entry) throw new Error("Operation was not recorded");
		return this.enqueue(entry.proposal.path, async () => {
			const row = (await this.storage.load(sessionId))?.operations.find(
				(item) => item.proposal.id === id,
			);
			if (!row) throw new Error("Operation was removed");
			const { proposal, receipt } = row;
			if (receipt.status !== "verified") return receipt;
			// No atomic compare-and-delete API. Never trash a note on a stale read.
			if (proposal.before === null)
				throw new Error("Created notes must be removed manually");
			await this.storage.assertNoUnresolvedWrite(proposal.path);
			if (!owns()) return receipt;
			await this.record(sessionId, proposal, "undo-pending");
			let status: WriteReceipt["status"];
			try {
				const file = await this.replace(
					proposal.path,
					proposal.after,
					proposal.before,
					owns,
				);
				status = (await this.verified(
					file,
					proposal.path,
					proposal.before,
				))
					? "undone"
					: "undo-pending";
			} catch (error) {
				status =
					error instanceof OwnerCancelled
						? "verified"
						: error instanceof Conflict
							? "conflict"
							: "undo-pending";
			}
			return this.record(sessionId, proposal, status);
		});
	}
}
