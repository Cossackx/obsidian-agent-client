import { Modal, Notice } from "obsidian";
import { findNoteSessions } from "../services/note-session-index";
import { compareSource, describeScope } from "../services/source-comparison";
import type { ContextItem } from "../types/note-companion";
import type AgentClientPlugin from "../plugin";
import type { SavedSessionInfo } from "../types/session";
import { computeDiffLines } from "../utils/diff-lines";

export async function openNoteSessionPicker(
	plugin: AgentClientPlugin,
	path: string,
	options: {
		current?: () => boolean;
		open: (session: SavedSessionInfo, resume: boolean) => Promise<void>;
		canResume: (session: SavedSessionInfo) => boolean;
		newChat: (items: ContextItem[]) => Promise<void>;
	},
) {
	const matches = await findNoteSessions(
		path,
		plugin.settingsService.getSavedSessions(),
		plugin.companionStorage,
	);
	if (options.current?.() === false) return;
	new (class extends Modal {
		onOpen() {
			this.setTitle(`Note conversations · ${path}`);
			this.contentEl.addClass("xo-note-modal");
			const run = (work: () => Promise<void>) => {
				void work().catch((error: unknown) => {
					new Notice(
						error instanceof Error
							? error.message
							: "Conversation action failed",
					);
				});
			};
			this.contentEl.createEl("button", {
				text: "New conversation",
			}).onclick = () => {
				this.close();
				run(() => options.newChat([]));
			};
			if (!matches.length)
				this.contentEl.createEl("p", {
					text: "No local companion sessions are associated with this exact path.",
				});
			for (const { session, companion } of matches) {
				const card = this.contentEl.createDiv("xo-note-chip");
				card.createEl("h4", {
					text: session.title || session.sessionId,
				});
				const tools = card.createDiv("xo-note-row");
				tools.createEl("button", {
					text: "Open history only",
				}).onclick = () => {
					this.close();
					run(() => options.open(session, false));
				};
				if (options.canResume(session))
					tools.createEl("button", {
						text: "Resume with agent",
					}).onclick = () => {
						this.close();
						run(() => options.open(session, true));
					};
				const carry = card.createEl("details");
				carry.createEl("summary", {
					text: "New conversation with selected context",
				});
				const choices = companion.items
					.filter((item) => item.role !== "destination")
					.map((item) => {
						const label = carry.createEl("label", {
							cls: "xo-note-row",
						});
						const checkbox = label.createEl("input", {
							type: "checkbox",
						});
						label.createSpan({
							text: `${item.source.path} · ${item.scope.kind}`,
						});
						return { item, checkbox };
					});
				carry.createEl("button", {
					text: "Stage checked context in a new chat (no send)",
				}).onclick = () => {
					this.close();
					run(() =>
						options.newChat(
							choices
								.filter(({ checkbox }) => checkbox.checked)
								.map(({ item }) => ({
									...item,
									selectionEdit: undefined,
								})),
						),
					);
				};
				const sources = [...companion.sent]
					.reverse()
					.flatMap((turn) =>
						turn.sources.filter(
							(item) => (item.currentPath ?? item.path) === path,
						),
					);
				if (!sources.length) {
					card.createEl("p", {
						text: "No confirmed sent snapshot is available.",
					});
					continue;
				}
				const picker = tools.createEl("select", {
					attr: { "aria-label": "Sent snapshot to compare" },
				});
				for (const [index, source] of sources.entries())
					picker.createEl("option", {
						value: String(index),
						text: `${describeScope(source.scope)} · ${new Date(source.capturedAt).toLocaleString()} · ${source.text.length} units · ${source.path}`,
					});
				tools.createEl("button", { text: "What changed?" }).onclick =
					() =>
						run(async () => {
							const prior = sources[picker.selectedIndex];
							if (!prior) return;
							const file = plugin.app.vault.getFileByPath(path);
							if (!file) {
								card.createEl("p", {
									text: "The source is no longer present; the original sent excerpt remains local.",
								});
								card.createEl("pre", { text: prior.text });
								return;
							}
							const snapshot = {
								path,
								text: await plugin.app.vault.read(file),
								capturedAt: Date.now(),
							};
							const comparison = compareSource(prior, snapshot);
							if (comparison.truncated)
								card.createEl("p", {
									text: "Only the transmitted prefix is compared; the remainder was not sent.",
								});
							const output = card.createEl("pre");
							output.setText(
								comparison.changed
									? computeDiffLines(
											comparison.before,
											comparison.after,
										)
											.map(
												(line) =>
													`${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "} ${line.content}`,
											)
											.join("\n")
									: "No textual change in this scope.",
							);
						});
			}
		}
	})(plugin.app).open();
}
