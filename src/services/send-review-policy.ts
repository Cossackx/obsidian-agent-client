import type { PreparedContext } from "./context-builder";

export interface SendReviewInput {
	/** Every source the prepared payload actually carries. */
	sources: PreparedContext["sources"];
	/** Vault paths the composer visibly represents (chips and typed @mentions). */
	represented: readonly string[];
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
	const shown = new Set(input.represented);
	for (const source of input.sources) {
		const path = source.currentPath ?? source.path;
		if (!shown.has(source.path) && !shown.has(path))
			reasons.push(`${path} is not shown in the composer.`);
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
