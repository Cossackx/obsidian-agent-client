/**
 * Vault Service
 *
 * Unified service implementing IVaultAccess port for Obsidian's Vault API.
 * Combines vault file access, fuzzy search (formerly NoteMentionService),
 * and editor selection tracking into a single service.
 */

import type AgentClientPlugin from "../plugin";
import {
	TFile,
	MarkdownView,
	prepareFuzzySearch,
	type EventRef,
} from "obsidian";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { StateEffect, Transaction, type EditorState } from "@codemirror/state";
import { getLogger, Logger } from "../utils/logger";
import type { SourceSnapshot, TextRange } from "../types/note-companion";
import { extractSelection, normalizeLineEndings } from "../utils/selection";
import {
	getNoteWikiLinks,
	type IWikilinkResolver,
	type LinkedNoteMetadata,
	type LineRange,
} from "../utils/wikilink-resolver";

/**
 * A document generation: a token whose identity is its object. Its file is
 * bound at most once, and only on affirmative evidence; it is never reassigned.
 */
type Generation = { file: TFile | null };
/** Shared by every VaultService: one record per EditorState and per editor view. */
const generations = new WeakMap<EditorState, Generation>();
const viewGenerations = new WeakMap<object, Generation>();
/** The state each editor showed at the last workspace notification. */
const lastSeen = new WeakMap<object, EditorState>();
const trackers = new Set<
	(update: ViewUpdate, generation: Generation) => void
>();

/**
 * The one selection listener, registered once by the plugin so every
 * EditorState carries it from creation. It decides each transaction's
 * generation once, before any panel sees it. A generation continues only
 * through a document-preserving transaction of the state its view last
 * showed; the user's own edit keeps the binding in a new token; any other
 * document change, an unseen state or a state swap mints an unbound token.
 * A retired generation can therefore never come back.
 */
const trackUpdate = (update: ViewUpdate): void => {
	const previous = generations.get(update.startState);
	const continues =
		!!previous && viewGenerations.get(update.view) === previous;
	const userEdit = update.transactions.some(
		(tr) => tr.annotation(Transaction.userEvent) !== undefined,
	);
	const generation =
		continues && !update.docChanged
			? previous
			: { file: continues && userEdit ? previous.file : null };
	generations.set(update.state, generation);
	viewGenerations.set(update.view, generation);
	for (const tracker of trackers) tracker(update, generation);
};
/** Registered once by the plugin (registerEditorExtension). */
export const selectionTracking = EditorView.updateListener.of(trackUpdate);

/** The generation the editor shows now; a reinstalled old state gets a new token. */
function currentGeneration(cm: EditorView): Generation {
	const known = generations.get(cm.state);
	if (known && viewGenerations.get(cm) === known) return known;
	const generation: Generation = { file: null };
	generations.set(cm.state, generation);
	viewGenerations.set(cm, generation);
	return generation;
}

/**
 * Edit authority for an explicit capture (rule C, evidence ii): the editor's
 * whole current document equals the named file's current vault content and
 * the file is still the live object at its path. Line endings are normalised
 * because the editor holds LF. Residual: two distinct files with
 * byte-identical content during a load window are indistinguishable.
 */
export async function documentIsFile(
	plugin: AgentClientPlugin,
	document: () => string,
	file: TFile,
): Promise<boolean> {
	const vault = plugin.app.vault;
	const live = () => vault.getAbstractFileByPath(file.path) === file;
	if (!live()) return false;
	const before = document();
	let saved: string;
	try {
		saved = await vault.read(file);
	} catch {
		return false;
	}
	return (
		live() &&
		document() === before &&
		normalizeLineEndings(before) === normalizeLineEndings(saved)
	);
}

/** Message for an explicit capture that stays frozen context only. */
export const CONTEXT_ONLY_NOTICE =
	"Added as context only: the note is still loading or has unsaved changes. Try again in a moment to enable editing.";

// ============================================================================
// Port Types (from vault-access.port.ts)
// ============================================================================

/**
 * Position in the editor (line and character).
 * Line numbers are 0-indexed.
 */
export interface EditorPosition {
	/** Line number (0-indexed) */
	line: number;
	/** Character position within the line */
	ch: number;
}

/**
 * Metadata for a note in the vault.
 *
 * Contains essential information about a note file without
 * exposing Obsidian's internal TFile structure.
 */
export interface NoteMetadata {
	/** Full path to the note within the vault (e.g., "folder/note.md") */
	path: string;

	/** Filename without extension (e.g., "note") */
	name: string;

	/** File extension (usually "md") */
	extension: string;

	/** Creation timestamp (milliseconds since epoch) */
	created: number;

	/** Last modified timestamp (milliseconds since epoch) */
	modified: number;

	/** Optional aliases from frontmatter */
	aliases?: string[];

	/** Optional text selection range in the editor */
	selection?: {
		from: EditorPosition;
		to: EditorPosition;
		text?: string;
		/** Non-enumerable live editor file; never persisted. */
		file?: TFile;
		range?: TextRange;
	};
}

/**
 * Interface for accessing vault notes and files.
 *
 * Provides methods for searching, reading, and listing notes
 * in the Obsidian vault. This port will be implemented by adapters
 * that use Obsidian's Vault API.
 */
export interface IVaultAccess {
	/**
	 * Read the content of a note.
	 *
	 * @param path - Path to the note within the vault
	 * @returns Promise resolving to note content as plain text
	 * @throws Error if note doesn't exist or cannot be read
	 */
	readNote(path: string): Promise<string>;

	/**
	 * Search for notes matching a query.
	 *
	 * Uses fuzzy search against note names, paths, and aliases.
	 * Returns up to 5 best matches sorted by relevance.
	 * If query is empty, returns recently modified files.
	 *
	 * @param query - Search query string (can be empty for recent files)
	 * @returns Promise resolving to array of matching note metadata
	 */
	searchNotes(query: string): Promise<NoteMetadata[]>;

	/**
	 * Get the currently active note in the editor.
	 *
	 * @returns Promise resolving to active note metadata, or null if no note is active
	 */
	getActiveNote(): Promise<NoteMetadata | null>;

	/**
	 * List all markdown notes in the vault.
	 *
	 * @returns Promise resolving to array of all note metadata
	 */
	listNotes(): Promise<NoteMetadata[]>;
}

/**
 * Normalize a frontmatter `aliases` value into a string array.
 *
 * Frontmatter is user-controlled YAML: `aliases` may be a string, an array,
 * or — via malformed YAML (e.g. a trailing colon turning an entry into an
 * object) — anything else. Non-string and empty-string values are dropped so
 * downstream consumers (fuzzy search, NoteMetadata) only ever see usable
 * strings (#354).
 */
function normalizeFrontmatterAliases(value: unknown): string[] {
	const list = Array.isArray(value) ? value : [value];
	return list.filter(
		(a): a is string => typeof a === "string" && a.length > 0,
	);
}

/**
 * Unified vault service for note access, fuzzy search, and selection tracking.
 *
 * Implements IVaultAccess port by wrapping Obsidian's Vault API,
 * providing built-in fuzzy search (formerly NoteMentionService),
 * and tracking editor selection state.
 */
export class VaultService implements IVaultAccess, IWikilinkResolver {
	private files: TFile[] = [];
	private lastBuild = 0;
	private logger: Logger;
	private vaultEventRefs: ReturnType<typeof this.plugin.app.vault.on>[] = [];

	private currentSelection: {
		filePath: string;
		/** Editor file at the selection event; refresh carries it, never a path lookup. */
		file?: TFile;
		selection: NonNullable<NoteMetadata["selection"]>;
		snapshot?: SourceSnapshot & { range: TextRange };
		/** Emitting editor and its document generation; the witness dies with it. */
		cm: EditorView;
		generation: Generation;
	} | null = null;
	private selectionListeners = new Set<() => void>();
	private activeLeafRef: EventRef | null = null;
	private fileOpenRef: EventRef | null = null;
	private tracker = (update: ViewUpdate, generation: Generation) =>
		this.onEditorUpdate(update, generation);
	private lastSelectionKey = "";

	constructor(private plugin: AgentClientPlugin) {
		// File index init
		this.logger = getLogger();
		this.rebuildIndex();
		this.registerVaultEvents();

		// Selection tracking init
		this.currentSelection = null;
		this.selectionListeners = new Set();
	}

	// ========================================================================
	// File Index (formerly NoteMentionService)
	// ========================================================================

	private rebuildIndex() {
		this.files = this.plugin.app.vault.getMarkdownFiles();
		this.lastBuild = Date.now();
		this.logger.log(
			`[VaultService] Rebuilt index with ${this.files.length} files`,
		);
	}

	private registerVaultEvents() {
		this.vaultEventRefs.push(
			this.plugin.app.vault.on("create", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.rebuildIndex();
				}
			}),
		);
		this.vaultEventRefs.push(
			this.plugin.app.vault.on("delete", () => this.rebuildIndex()),
		);
		this.vaultEventRefs.push(
			this.plugin.app.vault.on("rename", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.rebuildIndex();
				}
			}),
		);
	}

	getAllFiles(): TFile[] {
		return this.files;
	}

	getFileByPath(path: string): TFile | null {
		return this.files.find((file) => file.path === path) || null;
	}

	// ========================================================================
	// IVaultAccess Implementation
	// ========================================================================

	/**
	 * Read the content of a note.
	 *
	 * @param path - Path to the note within the vault
	 * @returns Promise resolving to note content as plain text
	 * @throws Error if note doesn't exist or cannot be read
	 */
	async readNote(path: string): Promise<string> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found: ${path}`);
		}
		return await this.plugin.app.vault.read(file);
	}

	/**
	 * Search for notes matching a query.
	 *
	 * Uses fuzzy search against note names, paths, and aliases.
	 * Returns up to 20 best matches sorted by relevance.
	 * If query is empty, returns recently modified files.
	 *
	 * @param query - Search query string (can be empty for recent files)
	 * @returns Promise resolving to array of matching note metadata
	 */
	searchNotes(query: string): Promise<NoteMetadata[]> {
		if (!query.trim()) {
			const recentFiles = this.files
				.slice()
				.sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0))
				.slice(0, 20);
			return Promise.resolve(
				recentFiles.map((file) => this.convertToMetadata(file)),
			);
		}

		const fuzzySearch = prepareFuzzySearch(query.trim());

		const scored: Array<{ file: TFile; score: number }> = this.files.map(
			(file) => {
				const basename = file.basename;
				const path = file.path;
				const fileCache =
					this.plugin.app.metadataCache.getFileCache(file);
				const aliases = normalizeFrontmatterAliases(
					fileCache?.frontmatter?.aliases,
				);

				const searchFields = [basename, path, ...aliases];
				let bestScore = -Infinity;

				for (const field of searchFields) {
					const match = fuzzySearch(field);
					if (match && match.score > bestScore) {
						bestScore = match.score;
					}
				}

				return { file, score: bestScore };
			},
		);

		const results = scored
			.filter((item) => item.score > -Infinity)
			.sort((a, b) => b.score - a.score)
			.slice(0, 20)
			.map((item) => this.convertToMetadata(item.file));
		return Promise.resolve(results);
	}

	/**
	 * Get the currently active note in the editor.
	 *
	 * Returns the active note with current selection if available.
	 *
	 * @returns Promise resolving to active note metadata, or null if no note is active
	 */
	getActiveNote(): Promise<NoteMetadata | null> {
		const workspace = this.plugin.app.workspace;
		const activeFile = workspace.getActiveFile();
		if (!activeFile) return Promise.resolve(null);

		// getActiveFile() falls back to the most recently active file when the
		// focused view is not a FileView (e.g. the chat panel), even after that
		// file has been closed. Only use it if it is still open in a markdown leaf.
		if (!workspace.getActiveViewOfType(MarkdownView)) {
			const stillOpen = workspace
				.getLeavesOfType("markdown")
				.some(
					(leaf) =>
						leaf.view instanceof MarkdownView &&
						leaf.view.file === activeFile,
				);
			if (!stillOpen) return Promise.resolve(null);
		}

		const metadata = this.convertToMetadata(activeFile);

		// Add selection if we have it stored for this file
		if (
			this.currentSelection &&
			this.witnessLive() &&
			this.currentSelection.filePath === activeFile.path
		) {
			// Carry the file captured with the selection; a same-path occupant
			// shows the original, so consumers see the mismatch and review.
			metadata.selection = Object.defineProperty(
				{ ...this.currentSelection.selection },
				"file",
				{ value: this.currentSelection.file },
			);
		}

		return Promise.resolve(metadata);
	}

	async captureActiveSelection(allowCaret = false): Promise<
		| (SourceSnapshot & {
				range: TextRange;
				stillTarget?: () => boolean;
				/** Live editor file; strip before persisting. */
				file?: TFile;
		  })
		| null
	> {
		const workspace = this.plugin.app.workspace;
		const active = workspace.getActiveViewOfType(MarkdownView);
		const file = workspace.getActiveFile();
		const open = workspace
			.getLeavesOfType("markdown")
			.flatMap(({ view }) =>
				view instanceof MarkdownView &&
				view.file === file &&
				view.getMode() === "source"
					? [view]
					: [],
			);
		const view = active ?? (open.length === 1 ? open[0] : null);
		if (view?.file && view.getMode() === "source") {
			const file = view.file;
			const path = file.path;
			const selection = view.editor.listSelections()[0];
			if (!selection) return null;
			const text = view.editor.getValue();
			// Edit authority only with affirmative evidence; otherwise frozen context.
			const owned =
				(await documentIsFile(
					this.plugin,
					() => view.editor.getValue(),
					file,
				)) &&
				view.file === file &&
				view.editor.getValue() === text;
			const { range } = extractSelection(
				text,
				selection.anchor,
				selection.head ?? selection.anchor,
			);
			// Non-enumerable: spreads, JSON and structuredClone never persist it.
			const live = (capture: SourceSnapshot & { range: TextRange }) =>
				owned
					? Object.defineProperty(capture, "file", { value: file })
					: capture;
			return allowCaret || range.start < range.end
				? live({
						path,
						text,
						range,
						capturedAt: Date.now(),
						...(allowCaret && {
							stillTarget: () =>
								file.path === path &&
								this.plugin.app.vault.getAbstractFileByPath(
									path,
								) === file,
						}),
					})
				: null;
		}
		if (allowCaret) return null;
		const note = await this.getActiveNote();
		const cached = this.currentSelection;
		// A followed selection is context only: frozen, never edit authority.
		return note &&
			cached?.snapshot &&
			this.witnessLive() &&
			cached.file &&
			cached.filePath === note.path &&
			file === cached.file &&
			this.plugin.app.vault.getAbstractFileByPath(cached.filePath) ===
				cached.file
			? { ...cached.snapshot }
			: null;
	}

	/**
	 * List all markdown notes in the vault.
	 *
	 * @returns Promise resolving to array of all note metadata
	 */
	listNotes(): Promise<NoteMetadata[]> {
		return Promise.resolve(
			this.files.map((file) => this.convertToMetadata(file)),
		);
	}

	// ========================================================================
	// IWikilinkResolver Implementation
	// ========================================================================

	getNoteWikiLinks(
		notePath: string,
		lineRange?: LineRange,
	): LinkedNoteMetadata[] {
		return getNoteWikiLinks(this.plugin.app, notePath, lineRange);
	}

	// ========================================================================
	// Selection Tracking
	// ========================================================================

	/**
	 * Subscribe to selection changes for the active markdown editor.
	 *
	 * The adapter will monitor the currently active MarkdownView and
	 * keep track of its selection, notifying subscribers whenever the
	 * selection or active file changes.
	 */
	subscribeSelectionChanges(listener: () => void): () => void {
		this.selectionListeners.add(listener);
		this.ensureSelectionTracking();

		return () => {
			this.selectionListeners.delete(listener);
			if (this.selectionListeners.size === 0) {
				this.teardownSelectionTracking();
			}
		};
	}

	private ensureSelectionTracking(): void {
		if (this.activeLeafRef) {
			return;
		}

		const workspace = this.plugin.app.workspace;
		trackers.add(this.tracker);
		this.onWorkspaceChange();
		// Workspace signals only re-query; they never capture or bind.
		this.activeLeafRef = workspace.on("active-leaf-change", () =>
			this.onWorkspaceChange(),
		);
		this.fileOpenRef = workspace.on("file-open", () =>
			this.onWorkspaceChange(),
		);
	}

	private teardownSelectionTracking(): void {
		trackers.delete(this.tracker);
		for (const ref of [this.activeLeafRef, this.fileOpenRef]) {
			if (ref) this.plugin.app.workspace.offref(ref);
		}
		this.activeLeafRef = null;
		this.fileOpenRef = null;
		this.lastSelectionKey = "";
	}

	/** The witness survives only while its editor still shows its generation. */
	private witnessLive(): boolean {
		const witness = this.currentSelection;
		if (
			witness &&
			generations.get(witness.cm.state) === witness.generation &&
			viewGenerations.get(witness.cm) === witness.generation
		) {
			// Unbound (still loading) shows nothing but may be bound later.
			return witness.generation.file === witness.file;
		}
		this.currentSelection = null;
		return false;
	}

	private onWorkspaceChange(): void {
		this.lastSelectionKey = "none";
		const view =
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		// WARNING: editor.cm is Obsidian's undocumented CodeMirror 6 handle.
		const cm = (view?.editor as unknown as { cm?: EditorView } | undefined)
			?.cm;
		const file = view?.file;
		if (view && file && cm?.state) {
			const state = cm.state;
			// Evidence (i): a new state installed since this editor was last seen.
			const fresh = lastSeen.has(cm) && lastSeen.get(cm) !== state;
			lastSeen.set(cm, state);
			// The plugin registers the listener for every new state; a state that
			// predates it gets the same shared extension.
			if (!state.facet(EditorView.updateListener).includes(trackUpdate))
				cm.dispatch({
					effects: StateEffect.appendConfig.of(selectionTracking),
				});
			lastSeen.set(cm, cm.state);
			const generation = currentGeneration(cm);
			if (generation.file === null) {
				if (fresh) this.bind(view, cm, generation, file, true);
				// Evidence (ii) for an editor first seen now (cold start).
				else
					void documentIsFile(
						this.plugin,
						() => cm.state.doc.toString(),
						file,
					).then((owned) => {
						if (owned && currentGeneration(cm) === generation)
							this.bind(view, cm, generation, file, false);
					});
			}
		}
		this.notifySelectionListeners();
	}

	/**
	 * Binds an unbound generation once. A load commit (i) also shows the range
	 * made in that state; a cold match (ii) shows only later selections.
	 */
	private bind(
		view: MarkdownView,
		cm: EditorView,
		generation: Generation,
		file: TFile,
		showExisting: boolean,
	): void {
		if (generation.file !== null || view.file !== file) return;
		generation.file = file;
		if (showExisting) this.showSelection(view, cm, generation);
	}

	private onEditorUpdate(update: ViewUpdate, generation: Generation): void {
		if (!update.selectionSet && !update.docChanged) return;
		const view =
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor as unknown as
			| { cm?: EditorView }
			| undefined;
		if (!view?.file || editor?.cm !== update.view) return;
		this.showSelection(view, update.view, generation);
	}

	/** Witness only a selection on a generation bound to the view's file. */
	private showSelection(
		view: MarkdownView,
		cm: EditorView,
		generation: Generation,
	): void {
		const file = view.file;
		if (!file) return;
		const filePath = file.path;
		const { doc, selection } = cm.state;
		const { from, to } = selection.main;
		if (
			generation.file !== file ||
			view.getMode() !== "source" ||
			from === to
		) {
			const focused = (
				view.editor as unknown as { hasFocus(): boolean }
			).hasFocus();
			if (generation.file !== file || from !== to || focused)
				this.handleSelectionChange(filePath, null);
			return;
		}
		const at = (pos: number): EditorPosition => {
			const line = doc.lineAt(pos);
			return { line: line.number - 1, ch: pos - line.from };
		};
		this.handleSelectionChange(
			filePath,
			{ from: at(from), to: at(to) },
			doc.toString(),
			file,
			cm,
			generation,
		);
	}

	private handleSelectionChange(
		filePath: string | null,
		selection: { from: EditorPosition; to: EditorPosition } | null,
		buffer?: string,
		file?: TFile,
		cm?: EditorView,
		generation?: Generation,
	): void {
		const selectionKey = filePath
			? selection
				? `${filePath}:${selection.from.line}:${selection.from.ch}-${selection.to.line}:${selection.to.ch}`
				: `${filePath}:none`
			: "none";

		if (
			selectionKey === this.lastSelectionKey &&
			buffer === this.currentSelection?.snapshot?.text &&
			file === this.currentSelection?.file &&
			cm === this.currentSelection?.cm
		) {
			return;
		}

		this.lastSelectionKey = selectionKey;

		if (filePath && selection && cm && generation) {
			const excerpt =
				buffer === undefined
					? undefined
					: extractSelection(buffer, selection.from, selection.to);
			this.currentSelection = {
				filePath,
				file,
				cm,
				generation,
				selection: { ...selection, ...excerpt },
				snapshot:
					buffer !== undefined && excerpt
						? {
								path: filePath,
								text: buffer,
								range: excerpt.range,
								capturedAt: Date.now(),
							}
						: undefined,
			};
		} else if (
			this.currentSelection &&
			(filePath === null || this.currentSelection.filePath === filePath)
		) {
			this.currentSelection = null;
		}

		this.notifySelectionListeners();
	}

	private notifySelectionListeners(): void {
		for (const listener of this.selectionListeners) {
			try {
				listener();
			} catch (error) {
				getLogger().error(
					"[VaultService] Selection listener error",
					error,
				);
			}
		}
	}

	// ========================================================================
	// Lifecycle
	// ========================================================================

	/**
	 * Clean up all event listeners and tracking.
	 * Call this when the service is no longer needed.
	 */
	destroy(): void {
		// Clean up vault event listeners (from file index)
		for (const ref of this.vaultEventRefs) {
			this.plugin.app.vault.offref(ref);
		}
		this.vaultEventRefs = [];

		// Clean up selection tracking
		this.teardownSelectionTracking();
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	/**
	 * Convert Obsidian TFile to domain NoteMetadata.
	 *
	 * Extracts relevant properties from TFile and metadata cache,
	 * including frontmatter aliases.
	 *
	 * @param file - Obsidian TFile object
	 * @returns NoteMetadata object
	 */
	private convertToMetadata(file: TFile): NoteMetadata {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const aliases = normalizeFrontmatterAliases(
			cache?.frontmatter?.aliases,
		);

		return {
			path: file.path,
			name: file.basename,
			extension: file.extension,
			created: file.stat.ctime,
			modified: file.stat.mtime,
			aliases: aliases.length > 0 ? aliases : undefined,
		};
	}
}
