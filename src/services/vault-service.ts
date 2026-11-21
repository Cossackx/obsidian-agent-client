/**
 * Vault Service
 *
 * Unified service implementing IVaultAccess port for Obsidian's Vault API.
 * Combines vault file access, fuzzy search (formerly NoteMentionService),
 * and explicit editor selection capture into a single service.
 */

import type AgentClientPlugin from "../plugin";
import {
	TFile,
	MarkdownView,
	prepareFuzzySearch,
	type EventRef,
} from "obsidian";
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
 * Edit authority for an explicit capture (rule C, evidence ii): the editor's
 * whole current document equals the named file's current vault content and
 * the file is still the live object at its path. Line endings are normalised
 * because the editor holds LF. Residual: this is normalized-text equality, so
 * two distinct files with identical content during a load window are
 * indistinguishable.
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
 * Unified vault service for note access, fuzzy search, and explicit
 * selection capture.
 *
 * Implements IVaultAccess port by wrapping Obsidian's Vault API,
 * providing built-in fuzzy search (formerly NoteMentionService).
 * Selections are never tracked passively; they are read only when the
 * user explicitly captures one (Ask XO about selection / Add selection).
 */
export class VaultService implements IVaultAccess, IWikilinkResolver {
	private files: TFile[] = [];
	private lastBuild = 0;
	private logger: Logger;
	private vaultEventRefs: ReturnType<typeof this.plugin.app.vault.on>[] = [];

	private selectionListeners = new Set<() => void>();
	private activeLeafRef: EventRef | null = null;
	private fileOpenRef: EventRef | null = null;

	constructor(private plugin: AgentClientPlugin) {
		// File index init
		this.logger = getLogger();
		this.rebuildIndex();
		this.registerVaultEvents();
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
	 * Returns the active note's path only; Follow never carries a passage.
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

		return Promise.resolve(metadata);
	}

	async captureActiveSelection(allowCaret = false): Promise<
		| (SourceSnapshot & {
				range: TextRange;
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
					})
				: null;
		}
		return null;
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
	// Active Note Tracking
	// ========================================================================

	/**
	 * Subscribe to active-note changes (path only) so Follow stays current.
	 * Selections are never tracked; explicit commands capture at call time.
	 */
	subscribeSelectionChanges(listener: () => void): () => void {
		this.selectionListeners.add(listener);
		if (!this.activeLeafRef) {
			const workspace = this.plugin.app.workspace;
			const notify = () => this.notifySelectionListeners();
			this.activeLeafRef = workspace.on("active-leaf-change", notify);
			this.fileOpenRef = workspace.on("file-open", notify);
		}
		return () => {
			this.selectionListeners.delete(listener);
			if (this.selectionListeners.size === 0) {
				this.teardownSelectionTracking();
			}
		};
	}

	private teardownSelectionTracking(): void {
		for (const ref of [this.activeLeafRef, this.fileOpenRef]) {
			if (ref) this.plugin.app.workspace.offref(ref);
		}
		this.activeLeafRef = null;
		this.fileOpenRef = null;
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

		// Clean up active-note listeners
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
