import { extractSelection, normalizeLineEndings } from "../utils/selection";
import { assertRange, headingRanges } from "./context-builder";
import type { CompanionState, SourceSnapshot } from "../types/note-companion";

export function describeScope(
	scope: import("../types/note-companion").ContextScope,
): string {
	return scope.kind === "heading"
		? `${scope.heading} (occurrence ${scope.occurrence})`
		: scope.kind === "passage"
			? `passage ${scope.range.start}–${scope.range.end}`
			: "whole note";
}

export function compareSource(
	previous: CompanionState["sent"][number]["sources"][number],
	current: SourceSnapshot,
) {
	if ((previous.currentPath ?? previous.path) !== current.path)
		throw new Error("Source identity does not match");
	const scope = previous.scope;
	let after = current.text;
	if (scope.kind === "heading") {
		const heading = headingRanges(current.text).find(
			(row) =>
				row.heading === scope.heading &&
				row.occurrence === scope.occurrence,
		);
		if (!heading) throw new Error("The previously sent heading is missing");
		after = current.text.slice(
			previous.quoteKind === "approved-destination"
				? heading.bodyStart
				: heading.range.start,
			heading.range.end,
		);
	} else if (previous.positions) {
		after = extractSelection(
			current.text,
			previous.positions.from,
			previous.positions.to,
		).text;
	} else if (scope.kind === "passage") {
		assertRange(scope.range, current.text);
		after = current.text.slice(scope.range.start, scope.range.end);
	}
	const truncated =
		previous.originalLength !== undefined &&
		previous.originalLength > previous.text.length;
	// Compare passages in logical editor coordinates, counting only logical
	// line endings when matching the transmitted prefix. Whole notes and heading
	// captures are vault bytes; do not normalize those as a write preimage.
	const logicalPassage = scope.kind === "passage" && previous.positions;
	const expected = logicalPassage
		? normalizeLineEndings(previous.text)
		: previous.text;
	if (logicalPassage) after = normalizeLineEndings(after);
	if (truncated) after = after.slice(0, expected.length);
	return {
		changed: expected !== after,
		before: previous.text,
		after,
		truncated,
	};
}
