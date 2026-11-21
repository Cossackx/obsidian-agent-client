import type { ChatMessage } from "../types/chat";
import type {
	DestinationAnchor,
	NoteEditProposal,
	TextRange,
	WriteReceipt,
} from "../types/note-companion";
import { mapStoredRange } from "../utils/selection";
import { planLiteralEdit } from "./note-edit-planner";

export type LiteralTarget =
	| Exclude<DestinationAnchor, { kind: "range" }>
	| { kind: "caret"; path: string; text: string; range: TextRange };

export async function insertReply(input: {
	sessionId: string;
	message: ChatMessage;
	destination: DestinationAnchor | null;
	choose: () => Promise<LiteralTarget | null>;
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
	const target =
		destination && destination.kind !== "range"
			? structuredClone(destination)
			: await choose();
	if (!target || !current()) return;
	if (target.kind === "caret" && target.range.start !== target.range.end)
		throw new Error("Literal insertion cannot replace a selection.");
	const text = await read(target.path);
	if (!current()) return;
	const proposal = planLiteralEdit(
		{ path: target.path, text, capturedAt: Date.now() },
		target.kind === "caret"
			? {
					kind: "range",
					path: target.path,
					range: mapStoredRange(target.text, text, target.range),
				}
			: target,
		literal,
		target.kind === "caret" ? "insert" : "append",
		id,
	);
	return apply(sessionId, proposal, current);
}
