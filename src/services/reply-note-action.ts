import type { ChatMessage } from "../types/chat";
import type {
	DestinationAnchor,
	NoteEditProposal,
	WriteReceipt,
} from "../types/note-companion";
import { planLiteralEdit } from "./note-edit-planner";

export type LiteralTarget = Exclude<DestinationAnchor, { kind: "range" }> & {
	stillTarget?: () => boolean;
};

export async function insertReply(input: {
	sessionId: string;
	message: ChatMessage;
	destination: DestinationAnchor | null;
	choose: () => Promise<LiteralTarget | null>;
	/** Guard from the witness captured when `destination` was chosen; undefined if none is live. */
	bindTarget?: (
		destination: Exclude<DestinationAnchor, { kind: "range" }>,
	) => (() => boolean) | undefined;
	read: (path: string) => Promise<string>;
	current: () => boolean;
	apply: (
		id: string,
		proposal: NoteEditProposal,
		current: () => boolean,
	) => Promise<WriteReceipt>;
}) {
	const { sessionId, message, destination, choose, read, current, apply } =
		input;
	const id = message.id;
	const literal = message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n\n");
	if (message.role !== "assistant" || !literal.trim() || !current()) return;
	const direct =
		destination && destination.kind !== "range"
			? structuredClone(destination)
			: null;
	const target: LiteralTarget | null = direct ?? (await choose());
	if (!target || !current()) return;
	const stillTarget = direct
		? input.bindTarget?.(direct)
		: target.stillTarget;
	// A saved destination is only a path: without its choice witness, stop.
	if (direct && !stillTarget)
		throw new Error(
			"The destination note is no longer known. Choose the destination again in Note tools.",
		);
	// A path returned by the picker is not proof of what it offered.
	if (!direct && !stillTarget) return;
	const checkTarget = () => {
		if (stillTarget && !stillTarget())
			throw new Error(
				"The selected note moved or was replaced. Choose the destination again.",
			);
	};
	checkTarget();
	const text = await read(target.path);
	if (!current()) return;
	checkTarget();
	// The guard stays here; only a plain, journalable anchor reaches the planner.
	const anchor = { ...target };
	delete anchor.stillTarget;
	const proposal = planLiteralEdit(
		{ path: target.path, text, capturedAt: Date.now() },
		anchor,
		literal,
		"append",
		id,
	);
	return apply(
		sessionId,
		proposal,
		stillTarget ? () => current() && stillTarget() : current,
	);
}
