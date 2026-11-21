import { MarkdownView } from "obsidian";
import { describeScope } from "../services/source-comparison";
import * as React from "react";
import { Modal, Notice, TFile, type App } from "obsidian";
import type {
	ContextItem,
	ContextQuote,
	DestinationAnchor,
	SourceSnapshot,
	NoteEditProposal,
} from "../types/note-companion";
import type { useNoteCompanion } from "../hooks/useNoteCompanion";
import type { ChatMessage } from "../types/chat";
import {
	moveItem,
	putItem,
	refreshItem,
	removeItem,
} from "../services/companion-state";
import {
	contextText,
	headingRanges,
	isNotePath,
} from "../services/context-builder";
import {
	describeNoteTarget,
	planLiteralEdit,
} from "../services/note-edit-planner";
import { computeDiffLines } from "../utils/diff-lines";
import {
	type CaptureIntent,
	buildCapturePrompt,
	validateCaptureProposal,
} from "../services/capture-proposal";
import {
	createRevisionProposal,
	passagePrompt,
	validatePassageRevisions,
} from "../services/passage-review";
import {
	buildSynthesisPrompt,
	type SynthesisPurpose,
} from "../services/synthesis-request";
import { NoteActionModal } from "./NoteActionModal";
import type { ReplyProposal } from "./ReplyNoteActions";
import { useChatContext } from "./ChatContext";
import { mapStoredRange } from "../utils/selection";
import { getVaultDragFiles } from "../utils/vault-drag";

export interface StructuredTurn {
	text: string;
	intent?: string;
	quotes?: readonly ContextQuote[];
	items?: readonly ContextItem[];
	onReply?: (result: unknown, id: string) => void;
}

function ReceiptDetails({ proposal }: { proposal: NoteEditProposal }) {
	const [expanded, setExpanded] = React.useState(false);
	return (
		<details onToggle={(event) => setExpanded(event.currentTarget.open)}>
			<summary>Change and source</summary>
			<small>Source reply: {proposal.sourceMessageId}</small>
			{expanded && (
				<>
					{/* JSON string literals keep CRLF, final newline and Unicode escapes exact for manual recovery. */}
					<small>Exact text before (null: note did not exist)</small>
					<pre>{JSON.stringify(proposal.before)}</pre>
					<small>Exact text after</small>
					<pre>{JSON.stringify(proposal.after)}</pre>
				</>
			)}
			{expanded && (
				<pre>
					{computeDiffLines(proposal.before ?? "", proposal.after)
						.filter((line) => line.type !== "context")
						.map(
							(line) =>
								`${line.type === "added" ? "+" : "−"} ${line.content}`,
						)
						.join("\n")}
				</pre>
			)}
		</details>
	);
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
	ownsComposer,
	runMutation,
	guardedUpdate,
	messages,
	canSend,
	busy,
	send,
	onProposals,
	witnesses,
	onClose,
	followPath,
}: {
	companion: ReturnType<typeof useNoteCompanion>;
	ownsComposer: () => boolean;
	runMutation: <T>(
		work: () => Promise<T>,
		surfaceAlive: () => boolean,
	) => Promise<T>;
	guardedUpdate: (
		change: Parameters<ReturnType<typeof useNoteCompanion>["update"]>[0],
		kind: string,
		surfaceAlive: () => boolean,
	) => Promise<void>;
	messages: ChatMessage[];
	canSend: boolean;
	busy: boolean;
	send: (turn: StructuredTurn) => Promise<boolean>;
	onProposals: (rows: ReplyProposal[]) => void;
	/** Live only: context item id -> TFile captured with it. */
	witnesses: Map<string, TFile>;
	onClose: () => void;
	followPath?: string;
}) {
	const { plugin, vaultService } = useChatContext();
	const { app } = plugin;
	const { state } = companion;
	const sessionId = state?.sessionId;
	const current = React.useRef<string | undefined>(sessionId);
	current.current = sessionId;
	React.useLayoutEffect(
		() => () => {
			current.current = undefined;
		},
		[],
	);
	const surfaceAlive = () =>
		!!sessionId && current.current === sessionId && ownsComposer();
	const update = (
		change: Parameters<typeof companion.update>[0],
		kind: string,
	) => guardedUpdate(change, kind, surfaceAlive);
	const [working, setWorking] = React.useState(false);
	const lock = React.useRef(false);
	const [message, setMessage] = React.useState("");
	const [replyId, setReplyId] = React.useState("");
	const [excerpt, setExcerpt] = React.useState<{
		messageId: string;
		start: number;
		end: number;
	} | null>(null);
	const [createPath, setCreatePath] = React.useState("");
	const [synthesis, setSynthesis] = React.useState<{
		id: string;
		sources: ContextItem[];
	} | null>(null);
	const [template, setTemplate] = React.useState<SourceSnapshot | null>(null);
	const [purpose, setPurpose] = React.useState<SynthesisPurpose>("synthesis");
	const replies = messages.filter(
		(row) =>
			row.role === "assistant" &&
			row.content.some((c) => c.type === "text"),
	);

	const reply = replyId
		? replies.find((row) => row.id === replyId)
		: replies[replies.length - 1];
	const fullReply =
		reply?.content
			.flatMap((c) => (c.type === "text" ? [c.text] : []))
			.join("\n\n") ?? "";
	const literal =
		excerpt && excerpt.messageId === reply?.id
			? fullReply.slice(excerpt.start, excerpt.end)
			: fullReply;
	const run = (work: () => Promise<unknown>, serialize = true) => {
		if (lock.current) return;
		lock.current = true;
		setWorking(true);
		setMessage("");
		void (serialize ? runMutation(work, surfaceAlive) : work())
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
	const addPaths = async (
		paths: string[],
		role: "working" | "reference",
		lifetime: "turn" | "session",
	) => {
		if (!sessionId) return;
		const entries: ContextItem[] = await Promise.all(
			[...new Set(paths)].map(async (path) => ({
				id: crypto.randomUUID(),
				source: await read(path),
				role,
				lifetime,
				scope: { kind: "note" },
			})),
		);
		if (current.current === sessionId)
			await update(
				(old) => entries.reduce(putItem, old),
				`add:${crypto.randomUUID()}`,
			);
	};
	const editItem = (
		id: string,
		field: string,
		change: Partial<ContextItem>,
	) =>
		update(
			(old) => ({
				...old,
				items: old.items.map((row) =>
					row.id === id ? { ...row, ...change } : row,
				),
			}),
			`item:${id}:${field}`,
		);
	const favourites = state?.favourites ?? [];
	const projectActions = [
		[
			"Brief me",
			"Brief me on the selected project sources. Separate current state, decisions and next actions.",
		],
		[
			"Challenge this plan",
			"Challenge this plan using the selected sources. Identify assumptions, failure points and alternatives.",
		],
		[
			"Where were we?",
			"Recap this conversation: decisions, open issues and next actions. This recap is not the source of truth.",
		],
	] as const;
	const projectButton = ([label, text]: (typeof projectActions)[number]) => (
		<button
			key={label}
			type="button"
			disabled={!canSend || working || busy}
			onClick={() =>
				run(
					() =>
						send({
							text: `${text} Do not invoke tools or edit files.`,
							intent: label,
						}),
					false,
				)
			}
		>
			{label}
		</button>
	);
	const synthesize = async () => {
		if (!state || !sessionId) return;
		const sources = state.items.filter(
			(item) => item.role !== "destination",
		);
		setSynthesis(null);
		await send({
			text: `${buildSynthesisPrompt(sources, purpose)} Return the synthesis as a string value.`,
			intent: `Bring these together: ${purpose}`,
			items: sources,
			onReply: (result, id) => {
				if (typeof result === "string" && current.current === sessionId)
					setSynthesis({ id, sources });
			},
		});
	};
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
			const capture = await vaultService.captureActiveSelection();
			if (!capture || capture.stillTarget?.() === false)
				throw new Error(
					"Select a passage in an open source editor first.",
				);
			// Keep durable state plain; the live identity goes to witnesses.
			const { file, ...source } = capture;
			if (file) witnesses.set(id, file);
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
			await update((old) => putItem(old, item), `add:${item.id}`);
	};
	const destination = async (kind: "note" | "range") => {
		let target: DestinationAnchor;
		if (kind === "range") {
			const capture = await vaultService.captureActiveSelection(true);
			if (!capture)
				throw new Error(
					"Place the caret or select text in a source editor first.",
				);
			const saved = await read(capture.path);
			const range = mapStoredRange(
				capture.text,
				saved.text,
				capture.range,
			);
			if (current.current !== sessionId) return;
			frozenTarget.current = {
				file: app.vault.getAbstractFileByPath(capture.path),
				source: saved,
				anchor: {
					kind: "range",
					path: capture.path,
					range,
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
			frozenTarget.current = {
				file: app.vault.getAbstractFileByPath(path),
				source,
				anchor: picked,
			};
		}
		if (current.current === sessionId)
			await update(
				(old) => ({ ...old, destination: target }),
				"destination",
			);
	};
	const frozenTarget = React.useRef<{
		/** Identity at destination choice; Accept refuses any substitute. */
		file: unknown;
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
			surfaceAlive,
			(receipt) => {
				if (current.current !== sessionId) return;
				setMessage(`${receipt.path}: ${receipt.status}`);
				runRefresh();
			},
			() => {
				if (current.current !== sessionId) return;
				setMessage(
					"Write outcome unconfirmed. Check the recorded receipt before retrying.",
				);
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
			intent: "Review captured passages",
			items,
			onReply: (text, id) => {
				if (!ownsComposer()) return;
				try {
					const rows = validatePassageRevisions(text, items).flatMap(
						(revision) => {
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
											file: witnesses.get(item.id),
										},
									]
								: [];
						},
					);
					onProposals(rows);
					if (surfaceAlive())
						setMessage(
							"Review the proposed changes on the reply below.",
						);
				} catch {
					if (surfaceAlive())
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
		const chosen = frozenTarget.current;
		const file =
			intent === "new-note"
				? undefined
				: chosen &&
					  JSON.stringify(chosen.anchor) === JSON.stringify(target) &&
					  chosen.file instanceof TFile &&
					  chosen.file.path === target.path &&
					  app.vault.getAbstractFileByPath(target.path) === chosen.file
					? chosen.file
					: null;
		if (file === null)
			throw new Error(
				"Choose the destination heading again; the original note is no longer known.",
			);
		const original = intent === "new-note" ? null : await read(target.path);
		const section =
			original && target.kind === "heading"
				? headingRanges(original.text).find(
						(row) =>
							row.heading === target.heading &&
							row.occurrence === target.occurrence,
					)
				: null;
		if (
			section &&
			section.range.end - section.bodyStart >
				plugin.settings.displaySettings.maxSelectionLength
		)
			throw new Error(
				"The destination section exceeds the selection limit. Use literal placement or select a smaller section; a partial section cannot be replaced.",
			);
		if (original && !section)
			throw new Error(
				"The captured destination heading no longer exists.",
			);
		const quotes: NonNullable<StructuredTurn["quotes"]>[number][] = [
			{
				label: "Selected assistant reply",
				text: literal,
				limit: "selection",
			},
		];
		if (intent === "new-note" && template)
			quotes.push({
				label: `Template: ${template.path}`,
				text: template.text,
				limit: "note",
				source: {
					path: template.path,
					capturedAt: template.capturedAt,
					scope: { kind: "note" },
					kind: "template",
				},
			});
		if (section && original)
			quotes.push({
				label: `Approved destination section: ${target.path}`,
				text: original.text.slice(section.bodyStart, section.range.end),
				limit: "selection",
				source: {
					path: original.path,
					capturedAt: original.capturedAt,
					scope: {
						kind: "heading",
						heading: section.heading,
						occurrence: section.occurrence,
						range: {
							start: section.bodyStart,
							end: section.range.end,
						},
					},
					kind: "approved-destination",
				},
			});
		if (current.current !== sessionId) return;
		await send({
			text: buildCapturePrompt(intent, reply.id, target),
			intent: `Request editorial proposal (${intent}) for ${target.path}`,
			quotes,
			onReply: (result, generatedId) => {
				if (!ownsComposer()) return;
				try {
					const proposal = validateCaptureProposal(
						result,
						intent,
						target,
						original,
						reply.id,
					);
					onProposals([
						{
							proposal: {
								...proposal,
								sourceMessageId: generatedId,
							},
							file,
						},
					]);
					if (surfaceAlive())
						setMessage(
							"Review the proposed changes on the reply below.",
						);
				} catch {
					if (surfaceAlive())
						setMessage(
							"Reply did not match the editorial request. No write actions were created.",
						);
				}
			},
		});
	};
	const refresh = async (item: ContextItem) => {
		const change = refreshItem(item, await read(item.source.path));
		if (current.current === sessionId)
			await editItem(item.id, "capture", change);
	};
	return (
		<section
			className="xo-note-tray"
			aria-label="Note tools"
			onDragOver={(event) => {
				if (!busy && state && getVaultDragFiles(app)?.notes.length)
					event.preventDefault();
			}}
			onDrop={(event) => {
				const notes = getVaultDragFiles(app)?.notes;
				if (!state || working || busy || !notes?.length) return;
				event.preventDefault();
				event.stopPropagation();
				run(() =>
					addPaths(
						notes.map((note) => note.path).filter(isNotePath),
						"reference",
						"turn",
					),
				);
			}}
		>
			<div className="xo-note-row xo-note-tools-head">
				<strong>Note tools</strong>
				<button
					type="button"
					aria-label="Close note tools"
					onClick={() => {
						current.current = undefined;
						onClose();
					}}
				>
					Close
				</button>
			</div>
			{message && <p role="status">{message}</p>}
			{favourites.length > 0 && (
				<div
					className="xo-note-row"
					aria-label="Favourite project actions"
				>
					{projectActions
						.filter(([label]) => favourites.includes(label))
						.map(projectButton)}
				</div>
			)}
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
											editItem(item.id, "role", {
												role,
												...(role === "destination" && {
													selectionEdit: undefined,
												}),
											}),
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
											editItem(item.id, "lifetime", {
												lifetime:
													item.lifetime === "turn"
														? "session"
														: "turn",
											}),
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
											update(
												(old) =>
													moveItem(old, item.id, -1),
												`move:${crypto.randomUUID()}`,
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
											update(
												(old) =>
													moveItem(old, item.id, 1),
												`move:${crypto.randomUUID()}`,
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
											update(
												(old) =>
													removeItem(
														old,
														item.id,
														followPath,
													),
												`remove:${item.id}`,
											),
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
											void editItem(
												item.id,
												"annotation",
												{ annotation },
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
							onClick={() => run(review, false)}
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
							onClick={() => run(synthesize, false)}
						>
							Bring these together
						</button>
					</div>
					{synthesis &&
						replies.some(
							(candidate) => candidate.id === synthesis.id,
						) && (
							<div className="xo-note-chip">
								<strong>Synthesis · not fact-verified</strong>
								<p>Supplied sources:</p>
								<small>
									Sources supplied for reply {synthesis.id}
								</small>
								{synthesis.sources.map((item) => (
									<button
										key={item.id}
										type="button"
										onClick={() =>
											run(async () => {
												const file =
													app.vault.getFileByPath(
														item.source.path,
													);
												if (
													!file ||
													file.path !==
														item.source.path
												)
													throw new Error(
														"The exact source is no longer at this path",
													);
												const scope = item.scope;
												const text =
													await app.vault.read(file);
												const range =
													scope.kind === "heading"
														? headingRanges(
																text,
															).find(
																(row) =>
																	row.heading ===
																		scope.heading &&
																	row.occurrence ===
																		scope.occurrence,
															)?.range
														: scope.kind ===
															  "passage"
															? mapStoredRange(
																	item.source
																		.text,
																	text,
																	scope.range,
																)
															: null;
												if (
													scope.kind !== "note" &&
													!range
												)
													throw new Error(
														"This excerpt moved or changed; inspect the captured bytes before navigating.",
													);
												if (
													current.current !==
													sessionId
												)
													return;
												const leaf =
													app.workspace.getLeaf(
														"tab",
													);
												await leaf.openFile(
													file,
													range
														? {
																state: {
																	mode: "source",
																},
															}
														: undefined,
												);
												if (
													range &&
													leaf.view instanceof
														MarkdownView
												) {
													const editor =
														leaf.view.editor;
													const offsets =
														mapStoredRange(
															text,
															editor.getValue(),
															range,
														);
													const from =
															editor.offsetToPos(
																offsets.start,
															),
														to = editor.offsetToPos(
															offsets.end,
														);
													editor.setSelection(
														from,
														to,
													);
													editor.scrollIntoView(
														{ from, to },
														true,
													);
												}
											})
										}
									>
										{item.source.path} ·{" "}
										{describeScope(item.scope)}
									</button>
								))}
							</div>
						)}
					<details>
						<summary>Project actions</summary>
						<div className="xo-note-row">
							{projectActions.map(projectButton)}
							{projectActions.map(([label]) => (
								<label key={label}>
									<input
										type="checkbox"
										checked={favourites.includes(label)}
										disabled={busy || working}
										onChange={() =>
											run(() =>
												update(
													(old) => ({
														...old,
														favourites:
															favourites.includes(
																label,
															)
																? (
																		old.favourites ??
																		[]
																	).filter(
																		(
																			entry,
																		) =>
																			entry !==
																			label,
																	)
																: [
																		...new Set(
																			[
																				...(old.favourites ??
																					[]),
																				label,
																			],
																		),
																	],
													}),
													`favourite:${label}`,
												),
											)
										}
									/>{" "}
									Favourite: {label}
								</label>
							))}
							<button
								type="button"
								disabled={
									!canSend ||
									working ||
									busy ||
									!reply ||
									state.destination?.kind !== "heading"
								}
								onClick={() =>
									run(() => editorial("merge-section"), false)
								}
							>
								Update the brief
							</button>
						</div>
					</details>

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
											update(
												(old) => ({
													...old,
													destination: null,
												}),
												"destination",
											),
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
									<button
										type="button"
										disabled={busy || working}
										onClick={() =>
											run(async () => {
												const path = await choose(
													app,
													"Choose an open Markdown template (optional)",
													openNotes().map((path) => ({
														label: path,
														value: path,
													})),
												);
												if (path)
													setTemplate(
														await read(path),
													);
											})
										}
									>
										Choose template
									</button>
									{template && (
										<button
											type="button"
											onClick={() => setTemplate(null)}
										>
											Clear template: {template.path}
										</button>
									)}
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
													run(
														() => editorial(intent),
														false,
													)
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
											{describeNoteTarget(proposal)} ·{" "}
											{receipt.status}
										</span>
										<ReceiptDetails proposal={proposal} />
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
																!surfaceAlive()
															)
																return;
															const result =
																await plugin.noteActions.undo(
																	state.sessionId,
																	proposal.id,
																	surfaceAlive,
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
		</section>
	);
}
