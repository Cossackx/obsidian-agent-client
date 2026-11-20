import type {
	DestinationAnchor,
	NoteEditProposal,
	SourceSnapshot,
} from "../types/note-companion";
import { assertRange, headingRanges, isNotePath } from "./context-builder";

export function planLiteralEdit(
	source: SourceSnapshot,
	target: DestinationAnchor,
	text: string,
	mode: "append" | "insert" | "replace",
	sourceMessageId: string,
): NoteEditProposal {
	if (!isNotePath(target.path) || source.path !== target.path)
		throw new Error("Select an exact Markdown destination in this vault");
	if (!text.trim()) throw new Error("Choose a non-empty excerpt");
	const before = source.text;
	const newline = before.match(/\r\n|\n|\r/)?.[0] ?? "\n";
	let start = before.length;
	let end = start;
	let addition = text;
	if (target.kind === "range") {
		assertRange(target.range, before);
		start = target.range.start;
		end = mode === "replace" ? target.range.end : start;
		if (mode === "append" || (mode === "replace" && end === start))
			throw new Error("Choose a matching placement mode and range");
	} else {
		if (mode !== "append")
			throw new Error(
				"Insert and replace require a captured position or selection",
			);
		if (target.kind === "heading") {
			const heading = headingRanges(before).find(
				(row) =>
					row.heading === target.heading &&
					row.occurrence === target.occurrence,
			);
			if (!heading)
				throw new Error("The selected heading no longer exists");
			start = end = heading.range.end;
		}
		const prefix =
			start > 0 && !/[\r\n]$/.test(before.slice(0, start)) ? newline : "";
		const suffix = /[\r\n]$/.test(text) ? "" : newline;
		addition = prefix + text + suffix;
	}
	const after = before.slice(0, start) + addition + before.slice(end);
	if (after === before) throw new Error("No changes to apply");
	return {
		id: crypto.randomUUID(),
		path: target.path,
		target: structuredClone(target),
		before,
		after,
		mode,
		sourceMessageId,
	};
}

export function describeNoteTarget(proposal: NoteEditProposal): string {
	const { path, target } = proposal;
	if (target?.kind === "heading")
		return `${path} > ${target.heading} (occurrence ${target.occurrence})`;
	if (target?.kind === "range")
		return `${path} (offsets ${target.range.start}–${target.range.end})`;
	return proposal.mode === "append" && target?.kind === "end"
		? `${path} (end of note)`
		: path;
}
