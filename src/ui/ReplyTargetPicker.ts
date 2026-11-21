import { FuzzySuggestModal, TFile, type App } from "obsidian";
import type { LiteralTarget } from "../services/reply-note-action";
import { isNotePath } from "../services/context-builder";

export function bindReplyTarget(
	app: App,
	path: string,
	file = app.vault.getAbstractFileByPath(path),
) {
	return () =>
		file instanceof TFile &&
		file.path === path &&
		app.vault.getAbstractFileByPath(path) === file;
}

export function chooseReplyTarget(app: App, onInvalid?: () => void) {
	return new Promise<LiteralTarget | null>((resolve) => {
		const choices: LiteralTarget[] = [
			...app.vault
				.getMarkdownFiles()
				.filter((file) => isNotePath(file.path))
				.map((file) => ({
					kind: "end" as const,
					path: file.path,
					stillTarget: bindReplyTarget(app, file.path, file),
				})),
		];
		new (class extends FuzzySuggestModal<LiteralTarget> {
			getItems() {
				return choices;
			}
			getItemText(target: LiteralTarget) {
				return `Append to ${target.path}`;
			}
			onChooseItem(target: LiteralTarget) {
				if (target.stillTarget && !target.stillTarget()) {
					onInvalid?.();
					resolve(null);
					return;
				}
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
