import { Modal, type App } from "obsidian";
import type { PromptContent } from "../types/chat";

/** Shows the same frozen block array used by dispatch; never re-reads notes. */
export function confirmPayload(
	app: App,
	blocks: readonly PromptContent[],
	notices: readonly string[],
): Promise<boolean> {
	return new Promise((resolve) => {
		let approved = false;
		new (class extends Modal {
			onOpen() {
				this.setTitle("Review outbound context");
				this.contentEl.addClass("xo-note-modal");
				this.contentEl.createEl("p", {
					text: "These blocks will be sent to the configured agent. Context is not an access restriction.",
				});
				const characters = blocks.reduce(
					(count, block) =>
						count +
						(block.type === "text"
							? block.text.length
							: block.type === "resource"
								? block.resource.text.length
								: 0),
					0,
				);
				this.contentEl.createEl("p", {
					text: `${blocks.length} blocks · ${characters} text UTF-16 units (attachments counted separately)`,
				});
				for (const notice of notices)
					this.contentEl.createEl("p", {
						text: notice,
						cls: "xo-note-warning",
					});
				for (const block of blocks) {
					const heading =
						block.type === "resource"
							? block.resource.uri
							: block.type;
					const body =
						block.type === "text"
							? block.text
							: block.type === "resource"
								? block.resource.text
								: block.type === "image"
									? `Attached ${block.mimeType} image (${block.data.length} base64 units)`
									: JSON.stringify(block, null, 2);
					const details = this.contentEl.createEl("details", {
						attr: { open: "" },
					});
					details.createEl("summary", { text: heading });
					details.createEl("pre", { text: body });
					if (
						block.type === "image" &&
						/^image\/(?:png|jpe?g|gif|webp)$/i.test(block.mimeType)
					)
						details.createEl("img", {
							cls: "xo-note-preview-image",
							attr: {
								src: `data:${block.mimeType};base64,${block.data}`,
								alt: "Exact outbound image",
							},
						});
				}
				const actions = this.contentEl.createDiv("xo-note-row");
				const cancel = actions.createEl("button", { text: "Cancel" });
				cancel.onclick = () => this.close();
				actions.createEl("button", {
					text: "Send these blocks",
					cls: "mod-cta",
				}).onclick = () => {
					approved = true;
					this.close();
				};
				cancel.focus();
			}
			onClose() {
				resolve(approved);
			}
		})(app).open();
	});
}
