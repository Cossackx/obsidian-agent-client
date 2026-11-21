import { FuzzySuggestModal, type App } from "obsidian";
import type { LiteralTarget } from "../services/reply-note-action";
import { isNotePath } from "../services/context-builder";

export function chooseReplyTarget(
	app: App,
	caret?: Extract<LiteralTarget, { kind: "caret" }>,
) {
	return new Promise<LiteralTarget | null>((resolve) => {
		const choices: LiteralTarget[] = [
			...(caret ? [caret] : []),
			...app.vault
				.getMarkdownFiles()
				.filter((file) => isNotePath(file.path))
				.map(({ path }) => ({ kind: "end" as const, path })),
		];
		new (class extends FuzzySuggestModal<LiteralTarget> {
			getItems() {
				return choices;
			}
			getItemText(target: LiteralTarget) {
				return target.kind === "caret"
					? `Insert at captured cursor in ${target.path}`
					: `Append to ${target.path}`;
			}
			onChooseItem(target: LiteralTarget) {
				resolve(target);
			}
			onClose() {
				super.onClose();
				// SuggestModal can close before calling onChooseItem.
				queueMicrotask(() => resolve(null));
			}
		})(app).open();
	});
}
