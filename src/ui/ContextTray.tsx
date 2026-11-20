import * as React from "react";
import { Modal, Notice, TFile, type App } from "obsidian";
import type {
	ContextItem,
	DestinationAnchor,
	SourceSnapshot,
	NoteEditProposal,
} from "../types/note-companion";
import type { useNoteCompanion } from "../hooks/useNoteCompanion";
import type { ChatMessage } from "../types/chat";
import { moveItem, putItem } from "../services/companion-state";
import {
	contextText,
	headingRanges,
	isNotePath,
} from "../services/context-builder";
import { planLiteralEdit } from "../services/note-edit-planner";
import {
	type CaptureIntent,
	buildCapturePrompt,
	validateCaptureProposal,
} from "../services/capture-proposal";
import {
	createRevisionProposal,
	parseStructuredReply,
	passagePrompt,
	validatePassageRevisions,
} from "../services/passage-review";
import {
	buildSynthesisPrompt,
	type SynthesisPurpose,
} from "../services/synthesis-request";
import { NoteActionModal } from "./NoteActionModal";
import { useChatContext } from "./ChatContext";

export interface StructuredTurn {
	text: string;
	items?: readonly ContextItem[];
	onReply?: (reply: string, id: string) => void;
}

function choose<T>(
	app: App,
	title: string,
	choices: readonly { label: string; value: T }[],
): Promise<T | null> {
	return new Promise((resolve) => {
		let result: T | null = null;
		new (class extends Modal {
			onOpen() {
				this.setTitle(title);
				const list = this.contentEl.createDiv("xo-note-picker");
				if (!choices.length)
					list.createEl("p", { text: "No matching choices." });
				for (const choice of choices)
					list.createEl("button", { text: choice.label }).onclick =
						() => {
							result = choice.value;
							this.close();
						};
				const cancel = this.contentEl.createEl("button", {
					text: "Cancel",
				});
				cancel.onclick = () => this.close();
				(list.querySelector("button") ?? cancel).focus();
			}
			onClose() {
				resolve(result);
			}
		})(app).open();
	});
}

export function ContextTray({
	companion,
	messages,
	canSend,
	busy,
	send,
	openContinuity,
}: {
	companion: ReturnType<typeof useNoteCompanion>;
	messages: ChatMessage[];
	canSend: boolean;
	busy: boolean;
	send: (turn: StructuredTurn) => Promise<boolean>;
	openContinuity: () => Promise<void>;
}) {
	const { plugin, vaultService } = useChatContext();
	const { app } = plugin;
	const { state, update } = companion;
	const sessionId = state?.sessionId;
	const current = React.useRef<string | undefined>(sessionId);
	current.current = sessionId;
	React.useEffect(
		() => () => {
			current.current = undefined;
		},
		[],
	);
	const [working, setWorking] = React.useState(false);
	const lock = React.useRef(false);
	const [message, setMessage] = React.useState("");
	const [proposals, setProposals] = React.useState<{
		sessionId: string;
		rows: { proposal: NoteEditProposal; comment?: string }[];
	} | null>(null);
	const [replyId, setReplyId] = React.useState("");
	const [excerpt, setExcerpt] = React.useState<{
		messageId: string;
		start: number;
		end: number;
	} | null>(null);
	const [createPath, setCreatePath] = React.useState("");
	const [purpose, setPurpose] = React.useState<SynthesisPurpose>("synthesis");
	const replies = messages.filter(
		(row) =>
			row.role === "assistant" &&
			row.content.some((c) => c.type === "text"),
	);
	const reply =
		replies.find((row) => row.id === replyId) ??
		replies[replies.length - 1];
	const fullReply =
		reply?.content
			.flatMap((c) => (c.type === "text" ? [c.text] : []))
			.join("\n\n") ?? "";
	const literal =
		excerpt && excerpt.messageId === reply?.id
			? fullReply.slice(excerpt.start, excerpt.end)
			: fullReply;
	const run = (work: () => Promise<unknown>) => {
		if (lock.current) return;
		lock.current = true;
		setWorking(true);
		setMessage("");
		void work()
			.catch((error: unknown) =>
				setMessage(
					error instanceof Error
						? error.message
						: "Action did not complete",
				),
			)
			.finally(() => {
				lock.current = false;
				setWorking(false);
			});
	};
	const read = async (path: string): Promise<SourceSnapshot> => ({
		path,
		text: await vaultService.readNote(path),
		capturedAt: Date.now(),
	});
	const openNotes = () => [
		...new Set(
			app.workspace.getLeavesOfType("markdown").flatMap((leaf) => {
				const file = (leaf.view as { file?: TFile }).file;
				return file instanceof TFile && isNotePath(file.path)
					? [file.path]
					: [];
			}),
		),
	];
	const add = async (scope: "note" | "heading" | "passage") => {
		if (!sessionId) return;
		const id = crypto.randomUUID();
		let item: ContextItem;
		if (scope === "passage") {
			const source = await vaultService.captureActiveSelection();
			if (!source)
				throw new Error(
					"Select a passage in an open source editor first.",
				);
			item = {
				id,
				source,
				scope: { kind: "passage", range: source.range },
				role: "working",
				lifetime: "turn",
			};
		} else {
			const path = await choose(
				app,
				"Add an open note",
				openNotes().map((path) => ({ label: path, value: path })),
			);
			if (!path) return;
			const source = await read(path);
			item = {
				id,
				source,
				scope: { kind: "note" },
				role: "reference",
				lifetime: "turn",
			};
			if (scope === "heading") {
				const heading = await choose(
					app,
					"Choose a heading occurrence",
					headingRanges(source.text).map((row) => ({
						label: `${row.heading} · ${row.occurrence}`,
						value: row,
					})),
				);
				if (!heading) return;
				item.scope = { kind: "heading", ...heading };
			}
		}
		if (current.current === sessionId)
			await update((old) => putItem(old, item));
	};
	const destination = async (kind: "note" | "range") => {
		let target: DestinationAnchor;
		if (kind === "range") {
			const capture = await vaultService.captureActiveSelection();
			if (!capture)
				throw new Error(
					"Select text in a source editor to set the placement range.",
				);
			const saved = await read(capture.path);
			if (saved.text !== capture.text)
				throw new Error(
					"The open buffer differs from the stored note. Save or reselect it before placing a reply.",
				);
			frozenTarget.current = {
				source: capture,
				anchor: {
					kind: "range",
					path: capture.path,
					range: capture.range,
				},
			};
			target = frozenTarget.current.anchor;
		} else {
			const path = await choose(
				app,
				"Pick a destination note",
				openNotes().map((path) => ({ label: path, value: path })),
			);
			if (!path) return;
			const source = await read(path);
			const options: { label: string; value: DestinationAnchor }[] = [
				{ label: "End of note", value: { kind: "end", path } },
				...headingRanges(source.text).map(
					({ heading, occurrence }) => ({
						label: `${heading} · ${occurrence}`,
						value: {
							kind: "heading" as const,
							path,
							heading,
							occurrence,
						},
					}),
				),
			];
			const picked = await choose(app, `Placement in ${path}`, options);
			if (!picked) return;
			target = picked;
			frozenTarget.current = null;
		}
		if (current.current === sessionId)
			await update((old) => ({ ...old, destination: target }));
	};
	const frozenTarget = React.useRef<{
		source: SourceSnapshot;
		anchor: DestinationAnchor;
	} | null>(null);
	React.useEffect(() => {
		frozenTarget.current = null;
	}, [sessionId]);
	const preview = (proposal: NoteEditProposal) => {
		if (!sessionId || sessionId !== current.current) return;
		new NoteActionModal(
			plugin,
			sessionId,
			proposal,
			() => current.current === sessionId,
			(receipt) => {
				setMessage(`${receipt.path}: ${receipt.status}`);
				runRefresh();
			},
		).open();
	};
	const runRefresh = () => {
		void companion
			.refresh()
			.catch(() =>
				setMessage(
					"Receipt could not be reloaded. Do not retry the write blindly.",
				),
			);
	};
	const place = async (mode: "append" | "insert" | "replace") => {
		const target = state?.destination;
		if (!target || !reply)
			throw new Error("Choose a reply and a destination first.");
		const captured = frozenTarget.current;
		if (
			target.kind === "range" &&
			(!captured ||
				JSON.stringify(captured.anchor) !== JSON.stringify(target))
		)
			throw new Error(
				"Capture the destination range again before previewing.",
			);
		preview(
			planLiteralEdit(
				target.kind === "range" && captured
					? captured.source
					: await read(target.path),
				target,
				literal,
				mode,
				reply.id,
			),
		);
	};
	const review = async () => {
		const items =
			state?.items.filter(
				(item) =>
					item.scope.kind === "passage" &&
					item.role !== "destination",
			) ?? [];
		if (!items.length || !sessionId)
			throw new Error("Add at least one passage to review.");
		if (
			items.some(
				(item) =>
					contextText(item).length >
					plugin.settings.displaySettings.maxSelectionLength,
			)
		)
			throw new Error(
				"A passage exceeds the configured selection limit; capture a smaller excerpt.",
			);
		await send({
			text: passagePrompt,
			items,
			onReply: (text, id) => {
				if (current.current !== sessionId) return;
				try {
					const rows = validatePassageRevisions(
						parseStructuredReply(text),
						items,
					).flatMap((revision) => {
						const item = items.find(
							(row) => row.id === revision.itemId,
						);
						return item
							? [
									{
										proposal: createRevisionProposal(
											revision,
											item,
											id,
										),
										comment: revision.comment,
									},
								]
							: [];
					});
					setProposals({ sessionId, rows });
				} catch {
					setMessage(
						"Reply did not match the requested passages. No write actions were created.",
					);
				}
			},
		});
	};
	const editorial = async (intent: CaptureIntent) => {
		if (!reply || !sessionId || !literal.trim())
			throw new Error("Choose a reply or excerpt first.");
		const target =
			intent === "new-note"
				? { kind: "end" as const, path: createPath.trim() }
				: state?.destination;
		if (
			!target ||
			!isNotePath(target.path) ||
			(intent !== "new-note" && target.kind !== "heading")
		)
			throw new Error(
				"Specify a new .md path or choose an exact destination heading.",
			);
		if (
			intent === "new-note" &&
			app.vault.getAbstractFileByPath(target.path)
		)
			throw new Error("The new-note path already exists.");
		const original = intent === "new-note" ? null : await read(target.path);
		const section =
			original && target.kind === "heading"
				? headingRanges(original.text).find(
						(row) =>
							row.heading === target.heading &&
							row.occurrence === target.occurrence,
					)
				: null;
		if (original && !section)
			throw new Error(
				"The captured destination heading no longer exists.",
			);
		const text = `${buildCapturePrompt(intent, reply.id, target)}\n${JSON.stringify({ reply: literal, section: section && original?.text.slice(section.bodyStart, section.range.end) })}`;
		await send({
			text,
			onReply: (result) => {
				if (current.current !== sessionId) return;
				try {
					preview(
						validateCaptureProposal(
							parseStructuredReply(result),
							intent,
							target,
							original,
							reply.id,
						),
					);
				} catch {
					setMessage(
						"Reply did not match the editorial request. No write actions were created.",
					);
				}
			},
		});
	};
	const refresh = async (item: ContextItem) => {
		const source = await read(item.source.path);
		let scope = item.scope;
		if (scope.kind === "passage")
			throw new Error("Capture a changed passage again from the editor.");
		if (scope.kind === "heading") {
			const old = scope;
			const row = headingRanges(source.text).find(
				(entry) =>
					entry.heading === old.heading &&
					entry.occurrence === old.occurrence,
			);
			if (!row) throw new Error("The heading no longer exists.");
			scope = { kind: "heading", ...row };
		}
		if (current.current === sessionId)
			await update((old) => ({
				...old,
				items: old.items.map((row) =>
					row.id === item.id
						? {
								...row,
								id: crypto.randomUUID(),
								source,
								scope,
								status: undefined,
							}
						: row,
				),
			}));
	};
	return (
		<details className="xo-note-tray">
			<summary>
				Note companion
				{state?.items.length ? ` · ${state.items.length} attached` : ""}
			</summary>
			{companion.warning && (
				<p role="alert" className="xo-note-warning">
					{companion.warning}{" "}
					<button type="button" onClick={() => run(companion.retry)}>
						Retry save or load
					</button>
				</p>
			)}
			{message && <p role="status">{message}</p>}
			<div className="xo-note-row">
				<button
					type="button"
					disabled={working || busy}
					onClick={() => run(openContinuity)}
				>
					Note conversations
				</button>
			</div>
			{!state ? (
				<small>
					Companion storage is not ready for this conversation.
				</small>
			) : (
				<>
					<p className="xo-note-muted">
						Removing an attachment does not remove it from earlier
						turns.
					</p>
					<div className="xo-note-row">
						<button
							type="button"
							disabled={working || busy}
							onClick={() => run(() => add("note"))}
						>
							Add open note
						</button>
						<button
							type="button"
							disabled={working || busy}
							onClick={() => run(() => add("heading"))}
						>
							Add heading
						</button>
						<button
							type="button"
							disabled={working || busy}
							onClick={() => run(() => add("passage"))}
						>
							Add selection
						</button>
					</div>
					{state.items.map((item) => (
						<details key={item.id} className="xo-note-chip">
							<summary>
								{item.source.path} · {item.scope.kind} ·{" "}
								{item.role}
								{item.status ? ` · ${item.status}` : ""}
							</summary>
							<pre>
								{item.role === "destination"
									? "Destination only; no body will be sent."
									: contextText(item)}
							</pre>
							<div className="xo-note-row">
								<select
									aria-label={`Role for ${item.source.path}`}
									disabled={working || busy}
									value={item.role}
									onChange={(event) => {
										const role = event.target
											.value as ContextItem["role"];
										run(() =>
											update((old) =>
												putItem(old, { ...item, role }),
											),
										);
									}}
								>
									<option value="working">Working</option>
									<option value="reference">Reference</option>
									<option value="destination">
										Destination only
									</option>
								</select>
								<button
									type="button"
									disabled={working || busy}
									onClick={() =>
										run(() =>
											update((old) =>
												putItem(old, {
													...item,
													lifetime:
														item.lifetime === "turn"
															? "session"
															: "turn",
												}),
											),
										)
									}
								>
									{item.lifetime === "turn"
										? "Pin to session"
										: "Use once"}
								</button>
								<button
									type="button"
									disabled={working || busy}
									onClick={() =>
										run(() =>
											update((old) =>
												moveItem(old, item.id, -1),
											),
										)
									}
								>
									Move up
								</button>
								<button
									type="button"
									disabled={working || busy}
									onClick={() =>
										run(() =>
											update((old) =>
												moveItem(old, item.id, 1),
											),
										)
									}
								>
									Move down
								</button>
								<button
									type="button"
									disabled={
										working ||
										busy ||
										item.scope.kind === "passage"
									}
									onClick={() => run(() => refresh(item))}
								>
									Refresh
								</button>
								<button
									type="button"
									disabled={working || busy}
									onClick={() =>
										run(() =>
											update((old) => ({
												...old,
												items: old.items.filter(
													(row) => row.id !== item.id,
												),
											})),
										)
									}
								>
									Remove
								</button>
							</div>
							{item.scope.kind === "passage" && (
								<label>
									Annotation{" "}
									<input
										defaultValue={item.annotation ?? ""}
										disabled={working || busy}
										onBlur={(event) => {
											const annotation =
												event.target.value;
											void update((old) =>
												putItem(old, {
													...item,
													annotation,
												}),
											);
										}}
									/>
								</label>
							)}
						</details>
					))}
					<div className="xo-note-row">
						<button
							type="button"
							disabled={!canSend || working || busy}
							onClick={() => run(review)}
						>
							Review passages
						</button>
						<select
							aria-label="Synthesis purpose"
							value={purpose}
							onChange={(event) =>
								setPurpose(
									event.target.value as SynthesisPurpose,
								)
							}
						>
							<option value="synthesis">Synthesis</option>
							<option value="agreements">Agreements</option>
							<option value="contradictions">
								Contradictions
							</option>
							<option value="evidence-gaps">Evidence gaps</option>
						</select>
						<button
							type="button"
							disabled={!canSend || working || busy}
							onClick={() =>
								run(() =>
									send({
										text: buildSynthesisPrompt(
											state.items,
											purpose,
										),
									}),
								)
							}
						>
							Bring these together
						</button>
					</div>
					{proposals?.sessionId === sessionId &&
						proposals?.rows.map(({ proposal, comment }) => (
							<div key={proposal.id} className="xo-note-chip">
								<strong>{proposal.path}</strong>
								{comment && <p>{comment}</p>}
								<button
									type="button"
									onClick={() => preview(proposal)}
								>
									Review revision
								</button>
								<button
									type="button"
									onClick={() =>
										setProposals((old) =>
											old
												? {
														...old,
														rows: old.rows.filter(
															(row) =>
																row.proposal
																	.id !==
																proposal.id,
														),
													}
												: old,
										)
									}
								>
									Skip
								</button>
							</div>
						))}
					<details>
						<summary>Place a reply in a note</summary>
						<div className="xo-note-row">
							<button
								type="button"
								disabled={working || busy}
								onClick={() => run(() => destination("note"))}
							>
								Choose destination
							</button>
							<button
								type="button"
								disabled={working || busy}
								onClick={() => run(() => destination("range"))}
							>
								Capture destination selection
							</button>
							{state.destination && (
								<button
									type="button"
									disabled={working || busy}
									onClick={() =>
										run(() =>
											update((old) => ({
												...old,
												destination: null,
											})),
										)
									}
								>
									Clear destination
								</button>
							)}
						</div>
						{state.destination && (
							<p>
								Destination: {state.destination.path}
								{state.destination.kind === "heading"
									? ` · ${state.destination.heading} (${state.destination.occurrence})`
									: ` · ${state.destination.kind}`}
							</p>
						)}
						{reply && (
							<>
								<label>
									Reply{" "}
									<select
										value={reply.id}
										onChange={(event) => {
											setReplyId(event.target.value);
											setExcerpt(null);
										}}
									>
										{replies.map((row, index) => (
											<option key={row.id} value={row.id}>
												Reply {index + 1}
											</option>
										))}
									</select>
								</label>
								<label>
									Optional excerpt: select text here{" "}
									<textarea
										readOnly
										value={fullReply}
										rows={4}
										onSelect={(event) => {
											const {
												selectionStart,
												selectionEnd,
											} = event.currentTarget;
											setExcerpt(
												selectionStart === selectionEnd
													? null
													: {
															messageId: reply.id,
															start: selectionStart,
															end: selectionEnd,
														},
											);
										}}
									/>
								</label>
								{excerpt && (
									<button
										type="button"
										onClick={() => setExcerpt(null)}
									>
										Use whole reply
									</button>
								)}
								<div className="xo-note-row">
									{(
										["append", "insert", "replace"] as const
									).map((mode) => (
										<button
											key={mode}
											type="button"
											disabled={
												working ||
												busy ||
												!state.destination ||
												(state.destination.kind ===
													"range") ===
													(mode === "append")
											}
											onClick={() =>
												run(() => place(mode))
											}
										>
											{mode[0].toUpperCase() +
												mode.slice(1)}{" "}
											· preview
										</button>
									))}
								</div>
								<details>
									<summary>Editorial capture</summary>
									<label>
										New note vault path{" "}
										<input
											value={createPath}
											placeholder="Folder/Note.md"
											onChange={(event) =>
												setCreatePath(
													event.target.value,
												)
											}
										/>
									</label>
									<div className="xo-note-row">
										{(
											[
												[
													"merge-section",
													"Merge into section",
												],
												[
													"decision",
													"Capture decision",
												],
												["new-note", "Save as note"],
												[
													"close-loop",
													"Close the loop",
												],
											] as const
										).map(([intent, label]) => (
											<button
												key={intent}
												type="button"
												disabled={
													!canSend || working || busy
												}
												onClick={() =>
													run(() => editorial(intent))
												}
											>
												{label}
											</button>
										))}
									</div>
								</details>
							</>
						)}
					</details>
					{state.operations.length > 0 && (
						<details>
							<summary>
								Write receipts · {state.operations.length}
							</summary>
							{[...state.operations]
								.reverse()
								.map(({ proposal, receipt }) => (
									<div
										key={proposal.id}
										className="xo-note-chip"
									>
										<span>
											{receipt.path} · {receipt.status}
										</span>
										{[
											"pending",
											"unknown",
											"undo-pending",
										].includes(receipt.status) && (
											<button
												type="button"
												disabled={working}
												onClick={() =>
													run(async () => {
														await plugin.noteActions.reconcile(
															state.sessionId,
															proposal.id,
														);
														await companion.refresh();
													})
												}
											>
												Reconcile without writing
											</button>
										)}
										{receipt.status === "verified" &&
											proposal.before !== null && (
												<button
													type="button"
													disabled={working}
													onClick={() =>
														run(async () => {
															const confirmed =
																await choose(
																	app,
																	`Restore exact preimage of ${proposal.path}?`,
																	[
																		{
																			label: "Undo this write",
																			value: true,
																		},
																	],
																);
															if (
																!confirmed ||
																current.current !==
																	state.sessionId
															)
																return;
															const result =
																await plugin.noteActions.undo(
																	state.sessionId,
																	proposal.id,
																);
															new Notice(
																`${result.path}: ${result.status}`,
															);
															await companion.refresh();
														})
													}
												>
													Undo…
												</button>
											)}
									</div>
								))}
						</details>
					)}
				</>
			)}
		</details>
	);
}
