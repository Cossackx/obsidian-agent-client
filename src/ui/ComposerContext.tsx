import * as React from "react";
import type { ComposerChip } from "../services/companion-presentation";

export interface ComposerContextProps {
	chips: readonly ComposerChip[];
	disabled: boolean;
	onRemove: (chip: ComposerChip) => void;
	onTogglePin: (chip: ComposerChip) => void;
	onRefresh: (chip: ComposerChip) => void;
	onAdd: (event: React.MouseEvent<HTMLButtonElement>) => void;
	onTools: () => void;
	onPreview: () => void;
	toolsOpen: boolean;
}

const baseName = (path: string) =>
	path.split("/").pop()?.replace(/\.md$/i, "") ?? path;

/** The composer's context row: what the next send carries, nothing more. */
export function ComposerContext({
	chips,
	disabled,
	onRemove,
	onTogglePin,
	onRefresh,
	onAdd,
	onTools,
	onPreview,
	toolsOpen,
}: ComposerContextProps) {
	const [open, setOpen] = React.useState<string | null>(null);
	const detail = chips.find((chip) => chip.key === open);
	return (
		<div className="xo-composer-context" aria-label="Context for next send">
			<div className="xo-composer-chips" role="list">
				{chips.map((chip) => (
					<span
						key={chip.key}
						role="listitem"
						className={`xo-chip xo-chip-${chip.kind}${chip.status ? " xo-chip-stale" : ""}`}
						title={`${chip.path} · ${chip.scope}`}
					>
						<button
							type="button"
							className="xo-chip-label"
							aria-expanded={open === chip.key}
							onClick={() =>
								setOpen(open === chip.key ? null : chip.key)
							}
						>
							{chip.kind === "following" ? "↻ " : ""}
							{chip.selectionEdit ? "Suggest edit: " : ""}
							{baseName(chip.path)}
							{chip.status ? ` · ${chip.status}` : ""}
						</button>
						<button
							type="button"
							className="xo-chip-action"
							disabled={disabled}
							aria-pressed={chip.pinned}
							aria-label={
								chip.pinned
									? `Use ${chip.path} for next send only`
									: `Pin ${chip.path} to this conversation`
							}
							title={chip.pinned ? "Pinned · use once" : "Pin"}
							onClick={() => onTogglePin(chip)}
						>
							{chip.pinned ? "●" : "○"}
						</button>
						<button
							type="button"
							className="xo-chip-action"
							disabled={disabled}
							aria-label={`Remove ${chip.path} from context`}
							title="Remove"
							onClick={() => onRemove(chip)}
						>
							×
						</button>
					</span>
				))}
				<button
					type="button"
					className="xo-chip-add"
					disabled={disabled}
					aria-label="Add context"
					title="Add context"
					onClick={onAdd}
				>
					+ Context
				</button>
				<button
					type="button"
					className="xo-chip-add"
					aria-pressed={toolsOpen}
					onClick={onTools}
				>
					Note tools
				</button>
				<button
					type="button"
					className="xo-chip-add"
					disabled={disabled}
					title="Inspect the exact outbound payload before sending"
					onClick={onPreview}
				>
					Review & send
				</button>
			</div>
			{detail && (
				<div className="xo-chip-details" role="note">
					<strong>{detail.path}</strong>
					<span>
						{detail.scope}
						{detail.pinned ? " · pinned to this conversation" : ""}
					</span>
					{detail.kind === "following" && (
						<small>
							Follow shows the current note and sends only its
							path. Pin to capture the whole note. To include a
							passage, select it and use Ask XO about selection or
							Add selection. Edits come from Suggest edit to
							selection on a saved note. Removing this chip turns
							off following for this conversation.
						</small>
					)}
					{detail.annotation && (
						<small>Source annotation: {detail.annotation}</small>
					)}
					{detail.selectionEdit && (
						<small>
							Send to request a revision, or remove this chip to
							cancel the edit request.
						</small>
					)}
					{detail.status && (
						<button
							type="button"
							disabled={disabled}
							onClick={() => onRefresh(detail)}
						>
							Refresh from note
						</button>
					)}
					<small>
						Context is not an access restriction; agent tools can
						still read the vault.
					</small>
				</div>
			)}
		</div>
	);
}
