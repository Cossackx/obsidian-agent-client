import * as React from "react";
import type { TFile } from "obsidian";
import type { NoteEditProposal, WriteReceipt } from "../types/note-companion";
import { describeNoteTarget } from "../services/note-edit-planner";
import { computeDiffLines } from "../utils/diff-lines";

export type ReplyProposal = {
	proposal: NoteEditProposal;
	comment?: string;
	/** Live, never persisted: the existing note captured when the target was chosen. */
	file?: TFile;
};

function ReplyDiff({
	row,
	disabled,
	onAccept,
	onCancel,
}: {
	row: ReplyProposal;
	disabled: boolean;
	onAccept: () => void;
	onCancel: () => void;
}) {
	const { proposal, comment } = row;
	const lines = React.useMemo(
		() => computeDiffLines(proposal.before, proposal.after),
		[proposal],
	);
	return (
		<section className="xo-reply-diff" aria-label="Proposed note change">
			<strong>{describeNoteTarget(proposal)}</strong>
			{comment && <p>{comment}</p>}
			<div
				className="xo-reply-diff-lines"
				tabIndex={0}
				aria-label="Before and after diff"
			>
				{lines.map((line, index) => (
					<div key={index} className={`xo-note-diff-${line.type}`}>
						{line.type === "added"
							? "+ "
							: line.type === "removed"
								? "− "
								: "  "}
						{line.content}
					</div>
				))}
			</div>
			<details>
				<summary>Exact before and after</summary>
				<pre>
					{JSON.stringify(
						{ before: proposal.before, after: proposal.after },
						null,
						2,
					)}
				</pre>
			</details>
			<div className="xo-note-row">
				<button
					type="button"
					className="mod-cta"
					disabled={disabled}
					onClick={onAccept}
				>
					Accept
				</button>
				<button type="button" disabled={disabled} onClick={onCancel}>
					Cancel
				</button>
			</div>
		</section>
	);
}

export function ReplyNoteActions({
	insertLabel,
	onInsert,
	proposals,
	receipts,
	disabled,
	onAccept,
	onCancel,
	onUndo,
	onReconcile,
}: {
	insertLabel?: string;
	onInsert: () => void;
	proposals: ReplyProposal[];
	receipts: { proposal: NoteEditProposal; receipt: WriteReceipt }[];
	disabled: boolean;
	onAccept: (proposal: NoteEditProposal) => void;
	onCancel: (id: string) => void;
	onUndo: (id: string) => void;
	onReconcile: (id: string) => void;
}) {
	return (
		<div className="xo-reply-actions">
			{insertLabel && !proposals.length && !receipts.length && (
				<button type="button" disabled={disabled} onClick={onInsert}>
					{insertLabel}
				</button>
			)}
			{proposals.map((row) => (
				<ReplyDiff
					key={row.proposal.id}
					row={row}
					disabled={disabled}
					onAccept={() => onAccept(row.proposal)}
					onCancel={() => onCancel(row.proposal.id)}
				/>
			))}
			{receipts.map(({ proposal, receipt }) => (
				<div className="xo-note-row" key={receipt.operationId}>
					<span role="status">
						{describeNoteTarget(proposal)}:{" "}
						{receipt.status === "verified"
							? "Applied and verified"
							: receipt.status}
					</span>
					{receipt.status === "verified" &&
						proposal.before !== null && (
							<button
								type="button"
								disabled={disabled}
								onClick={() => onUndo(proposal.id)}
							>
								Undo
							</button>
						)}
					{["pending", "unknown", "undo-pending"].includes(
						receipt.status,
					) && (
						<button
							type="button"
							disabled={disabled}
							onClick={() => onReconcile(proposal.id)}
						>
							Reconcile
						</button>
					)}
				</div>
			))}
		</div>
	);
}
