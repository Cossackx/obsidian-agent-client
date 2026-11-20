import { assertRange, headingRanges } from "./context-builder";
import type { CompanionState, SourceSnapshot } from "../types/note-companion";

export function compareSource(
	previous: CompanionState["sent"][number]["sources"][number],
	current: SourceSnapshot,
) {
	if (previous.path !== current.path)
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
		after = current.text.slice(heading.range.start, heading.range.end);
	} else if (scope.kind === "passage") {
		assertRange(scope.range, current.text);
		after = current.text.slice(scope.range.start, scope.range.end);
	}
	return { changed: previous.text !== after, before: previous.text, after };
}
