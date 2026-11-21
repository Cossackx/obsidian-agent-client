import { contextText, type PreparedContext } from "./context-builder";
import type {
	ContextItem,
	ContextScope,
	SourcePosition,
} from "../types/note-companion";

export interface RepresentedSource {
	path: string;
	scope: ContextScope;
	text: string;
	provenance: "captured" | "mention" | "following";
	itemId?: string;
	positions?: { from: SourcePosition; to: SourcePosition };
}

export function representedItems(
	items: readonly ContextItem[],
): RepresentedSource[] {
	return items
		.filter((item) => item.role !== "destination")
		.map((item) => ({
			path: item.source.path,
			scope: item.scope,
			text: contextText(item),
			provenance: "captured",
			itemId: item.id,
		}));
}

function identity(source: RepresentedSource): string {
	const scope = source.scope;
	const pos = source.provenance === "following" && source.positions;
	return JSON.stringify([
		source.path,
		source.provenance,
		source.itemId,
		source.text,
		scope.kind,
		scope.kind === "note" ? null : [scope.range.start, scope.range.end],
		scope.kind === "heading" ? [scope.heading, scope.occurrence] : null,
		pos ? [pos.from.line, pos.from.ch, pos.to.line, pos.to.ch] : null,
	]);
}

export interface SendReviewInput {
	/** Every source the prepared payload actually carries. */
	sources: PreparedContext["sources"];
	/** Independent captures of sources visibly represented by the composer. */
	represented: readonly RepresentedSource[];
	/** Truncation/staleness notices raised while preparing the payload. */
	notices: readonly string[];
	/** Hidden generated instructions or structured requests ride with the turn. */
	generated: boolean;
	/** The user asked to inspect the exact payload. */
	requested: boolean;
}

export interface SendReviewDecision {
	required: boolean;
	reasons: string[];
}

/**
 * Decides whether a send must stop at the exact-payload review. A fully
 * represented ordinary send goes straight out; anything hidden, transformed,
 * truncated or not shown in the composer fails closed to review.
 */
export function decideSendReview(input: SendReviewInput): SendReviewDecision {
	const reasons: string[] = [];
	if (input.requested) reasons.push("Review requested.");
	if (input.generated)
		reasons.push("This turn includes generated instructions.");
	reasons.push(...input.notices);
	const shown = new Set(input.represented.map(identity));
	for (const source of input.sources) {
		const path = source.currentPath ?? source.path;
		if (path !== source.path)
			reasons.push(`${source.path} was renamed to ${path}.`);
		if (
			!source.quoteKind &&
			(!source.provenance ||
				!shown.delete(
					identity({ ...source, provenance: source.provenance }),
				))
		)
			reasons.push(
				`${path} (${source.scope.kind}) does not match an exact source shown in the composer.`,
			);
		if (
			source.originalLength !== undefined &&
			source.originalLength > source.text.length
		)
			reasons.push(
				`${path} is truncated to ${source.text.length} of ${source.originalLength} characters.`,
			);
		if (source.quoteKind)
			reasons.push(`${path} is included as ${source.quoteKind}.`);
	}
	const unique = [...new Set(reasons)];
	return { required: unique.length > 0, reasons: unique };
}
