import { Modal } from "obsidian";
import { computeDiffLines } from "../utils/diff-lines";
import type { NoteEditProposal, WriteReceipt } from "../types/note-companion";
import type AgentClientPlugin from "../plugin";
import { describeNoteTarget } from "../services/note-edit-planner";

export class NoteActionModal extends Modal {
	private applying = false;
	constructor(
		private plugin: AgentClientPlugin,
		private sessionId: string,
		private proposal: NoteEditProposal,
		private current: () => boolean,
		private onReceipt: (receipt: WriteReceipt) => void,
		private onUncertain: () => void,
	) {
		super(plugin.app);
	}
	onOpen() {
		const { proposal, contentEl } = this;
		this.setTitle(
			proposal.mode === "create"
				? "Review new note"
				: "Review note change",
		);
		contentEl.addClass("xo-note-modal");
		contentEl.createEl("p", { text: describeNoteTarget(proposal) });
		const diff = contentEl.createEl("pre", { cls: "xo-note-diff" });
		for (const line of computeDiffLines(
			proposal.before ?? "",
			proposal.after,
		)) {
			diff.createDiv({
				text: `${line.type === "added" ? "+" : line.type === "removed" ? "−" : " "} ${line.content}`,
				cls: `xo-note-diff-${line.type}`,
			});
		}
		const exact = contentEl.createEl("details");
		exact.createEl("summary", {
			text: "Exact before and after (JSON strings)",
		});
		exact.createEl("pre", {
			text: JSON.stringify(
				{ before: proposal.before, after: proposal.after },
				null,
				2,
			),
		});
		const status = contentEl.createEl("p", { attr: { role: "status" } });
		const actions = contentEl.createDiv("xo-note-row");
		const cancel = actions.createEl("button", { text: "Cancel" });
		const apply = actions.createEl("button", {
			text: "Apply this change",
			cls: "mod-cta",
		});
		cancel.onclick = () => this.close();
		apply.onclick = () => {
			if (this.applying) return;
			if (!this.current()) {
				status.setText("Conversation changed. Open a new preview.");
				return;
			}
			this.applying = true;
			apply.disabled = true;
			cancel.disabled = true;
			status.setText("Checking the saved preimage and applying…");
			void this.plugin.noteActions
				.apply(this.sessionId, proposal, this.current)
				.then(
					(receipt) => {
						this.onReceipt(receipt);
						status.setText(
							receipt.status === "verified"
								? "Applied and verified"
								: `Not verified: ${receipt.status}. Check the receipt before retrying.`,
						);
					},
					() => {
						this.onUncertain();
						status.setText(
							"Could not confirm the write or save its receipt. Inspect the note and reconcile the recorded operation before retrying.",
						);
					},
				)
				.finally(() => {
					cancel.disabled = false;
					cancel.setText("Close");
				});
		};
		cancel.focus();
	}
}
