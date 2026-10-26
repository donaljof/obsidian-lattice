import { App, Notice, TAbstractFile, TFile, normalizePath, requestUrl } from "obsidian";
import type LatticePlugin from "./main";
import { normalizeVector } from "./math";
import type { OKFFrontmatter, VectorRecord } from "./settings";

export class VectorIndexer {
	private app: App;
	private plugin: LatticePlugin;
	private store: Record<string, VectorRecord> = {};
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	public isOllamaOnline = false;
	public isIndexing = false;

	constructor(app: App, plugin: LatticePlugin, initialVectors: Record<string, VectorRecord> = {}) {
		this.app = app;
		this.plugin = plugin;
		this.store = initialVectors || {};
	}

	public getStore(): Record<string, VectorRecord> {
		return this.store;
	}

	public getRecord(path: string): VectorRecord | undefined {
		return this.store[path];
	}

	public getVectorCount(): number {
		return Object.keys(this.store).length;
	}

	/**
	 * Checks whether a file should be indexed according to OKF exclusion rules.
	 */
	public shouldIndexFile(file: TAbstractFile): file is TFile {
		if (!(file instanceof TFile)) return false;
		if (file.extension.toLowerCase() !== "md") return false;

		const { excludedFiles, excludedFolders } = this.plugin.settings;

		// Ignore OKF navigation files (e.g., index.md, log.md)
		const lowerName = file.name.toLowerCase();
		if (excludedFiles.some((f) => f.toLowerCase() === lowerName)) {
			return false;
		}

		// Ignore excluded folders
		const normPath = normalizePath(file.path);
		for (const folder of excludedFolders) {
			const cleanFolder = normalizePath(folder).replace(/^\/+|\/+$/g, "");
			if (
				cleanFolder &&
				(normPath === cleanFolder || normPath.startsWith(cleanFolder + "/"))
			) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Strips YAML frontmatter from raw markdown text so we don't duplicate
	 * YAML keys inside {note_body}.
	 */
	public static stripFrontmatter(rawContent: string): string {
		if (!rawContent.startsWith("---")) return rawContent.trim();
		const endMatch = rawContent.indexOf("\n---", 3);
		if (endMatch === -1) return rawContent.trim();
		const afterFence = rawContent.indexOf("\n", endMatch + 4);
		return afterFence === -1 ? "" : rawContent.slice(afterFence + 1).trim();
	}

	/**
	 * Normalizes tags from frontmatter (handles string, comma-separated, or array).
	 */
	public static normalizeTags(rawTags: unknown): string[] {
		if (!rawTags) return [];
		if (Array.isArray(rawTags)) {
			return rawTags
				.map((t) => String(t).trim().replace(/^#/, ""))
				.filter(Boolean);
		}
		if (typeof rawTags === "string") {
			return rawTags
				.split(/[,\s]+/)
				.map((t) => t.trim().replace(/^#/, ""))
				.filter(Boolean);
		}
		return [];
	}

	/**
	 * Constructs the OKF Context-Enriched Embedding String:
	 * Type: {frontmatter.type}
	 * Title: {file.basename}
	 * Description: {frontmatter.description}
	 * Tags: {frontmatter.tags.join(', ')}
	 *
	 * {note_body}
	 */
	public buildCompositeEmbeddingString(
		file: TFile,
		frontmatter: OKFFrontmatter | undefined,
		noteBody: string
	): {
		composite: string;
		type: string;
		title: string;
		description: string;
		tags: string[];
	} {
		const type =
			typeof frontmatter?.type === "string" && frontmatter.type.trim()
				? frontmatter.type.trim()
				: "Seed";
		const title =
			typeof frontmatter?.title === "string" && frontmatter.title.trim()
				? frontmatter.title.trim()
				: file.basename;
		const description =
			typeof frontmatter?.description === "string"
				? frontmatter.description.trim()
				: "";
		const tags = VectorIndexer.normalizeTags(frontmatter?.tags);

		const headerSummary = description ? `${title} — ${description}` : title;
		const composite = [
			`Title: ${title}`,
			description ? `Description: ${description}` : "",
			"",
			headerSummary,
			"",
			noteBody.slice(0, 4000),
		]
			.filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== ""))
			.join("\n");

		return { composite, type, title, description, tags };
	}

	/**
	 * Checks whether local Ollama is reachable.
	 */
	public async checkOllamaStatus(forceNotice = false): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${this.plugin.settings.ollamaUrl}/api/tags`,
				method: "GET",
				throw: false,
			});
			this.isOllamaOnline = response.status >= 200 && response.status < 300;
		} catch {
			this.isOllamaOnline = false;
		}

		this.plugin.updateStatusBar();
		this.plugin.refreshSidebar();

		if (!this.isOllamaOnline && forceNotice) {
			new Notice(
				`Lattice: Ollama is unreachable at ${this.plugin.settings.ollamaUrl}. Ensure Ollama is running with OLLAMA_ORIGINS="*".`
			);
		}
		return this.isOllamaOnline;
	}

	/**
	 * Requests a normalized embedding vector from Ollama's `/api/embed` endpoint
	 * (with automatic fallback to `/api/embeddings` for older Ollama releases).
	 */
	public async fetchEmbedding(text: string): Promise<number[] | null> {
		const baseUrl = this.plugin.settings.ollamaUrl;
		const model = this.plugin.settings.embeddingModel;

		try {
			// Primary Ollama /api/embed endpoint
			const res = await requestUrl({
				url: `${baseUrl}/api/embed`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model,
					input: text,
				}),
				throw: false,
			});

			if (res.status === 200 && res.json) {
				this.isOllamaOnline = true;
				const data = res.json;
				if (Array.isArray(data.embeddings) && Array.isArray(data.embeddings[0])) {
					return normalizeVector(data.embeddings[0]);
				}
				if (Array.isArray(data.embedding)) {
					return normalizeVector(data.embedding);
				}
			}

			// Check if 404 is due to the model not being pulled yet
			const errMsg =
				typeof res.json?.error === "string" ? res.json.error : res.text || "";
			if (res.status === 404 && errMsg.toLowerCase().includes("not found")) {
				this.isOllamaOnline = false;
				new Notice(
					`Lattice: Model "${model}" is not installed in Ollama. Open a second PowerShell and run: ollama pull ${model}`
				);
				return null;
			}

			// Fallback to legacy /api/embeddings if /api/embed endpoint itself is not found
			if (res.status === 404) {
				const legacyRes = await requestUrl({
					url: `${baseUrl}/api/embeddings`,
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model,
						prompt: text,
					}),
					throw: false,
				});
				if (legacyRes.status === 200 && legacyRes.json && Array.isArray(legacyRes.json.embedding)) {
					this.isOllamaOnline = true;
					return normalizeVector(legacyRes.json.embedding);
				}
			}

			return null;
		} catch {
			this.isOllamaOnline = false;
			return null;
		}
	}

	/**
	 * Debounced handler for vault create/modify events (default 2000ms).
	 */
	public queueFileIndex(file: TAbstractFile): void {
		if (!this.shouldIndexFile(file)) return;

		const existingTimer = this.debounceTimers.get(file.path);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const timer = setTimeout(async () => {
			this.debounceTimers.delete(file.path);
			await this.indexFile(file, false);
		}, this.plugin.settings.debounceMs);

		this.debounceTimers.set(file.path, timer);
	}

	/**
	 * Handles file deletion from the vector cache.
	 */
	public handleFileDelete(file: TAbstractFile): void {
		const existingTimer = this.debounceTimers.get(file.path);
		if (existingTimer) {
			clearTimeout(existingTimer);
			this.debounceTimers.delete(file.path);
		}

		if (this.store[file.path]) {
			delete this.store[file.path];
			this.scheduleSave();
			this.plugin.refreshSidebar();
		}
	}

	/**
	 * Handles file rename/move without re-running Ollama embedding if mtime hasn't changed.
	 */
	public handleFileRename(file: TAbstractFile, oldPath: string): void {
		const existingTimer = this.debounceTimers.get(oldPath);
		if (existingTimer) {
			clearTimeout(existingTimer);
			this.debounceTimers.delete(oldPath);
		}

		const oldRecord = this.store[oldPath];
		if (oldRecord) {
			delete this.store[oldPath];
		}

		if (!this.shouldIndexFile(file)) {
			this.scheduleSave();
			return;
		}

		if (oldRecord) {
			this.store[file.path] = {
				...oldRecord,
				path: file.path,
				title:
					oldRecord.title === oldPath.replace(/^.*\//, "").replace(/\.md$/i, "")
						? file.basename
						: oldRecord.title,
			};
			this.scheduleSave();
		}

		// Queue an incremental verify in case metadata changed
		this.queueFileIndex(file);
	}

	/**
	 * Indexes a single markdown file if its mtime has changed or force=true.
	 */
	public async indexFile(file: TFile, force = false): Promise<VectorRecord | null> {
		if (!this.shouldIndexFile(file)) return null;

		const existing = this.store[file.path];
		if (!force && existing && existing.mtime === file.stat.mtime && existing.vector.length > 0) {
			return existing;
		}

		try {
			const rawContent = await this.app.vault.cachedRead(file);
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = cache?.frontmatter as OKFFrontmatter | undefined;

			// Skip notes explicitly marked as type: Log
			if (
				typeof frontmatter?.type === "string" &&
				frontmatter.type.trim().toLowerCase() === "log"
			) {
				if (this.store[file.path]) {
					delete this.store[file.path];
					this.scheduleSave();
				}
				return null;
			}

			const noteBody = VectorIndexer.stripFrontmatter(rawContent);
			const { composite, type, title, description, tags } =
				this.buildCompositeEmbeddingString(file, frontmatter, noteBody);

			const vector = await this.fetchEmbedding(composite);
			if (!vector) {
				this.plugin.updateStatusBar();
				return existing || null;
			}

			const record: VectorRecord = {
				path: file.path,
				title,
				mtime: file.stat.mtime,
				type,
				description,
				tags,
				vector,
			};

			this.store[file.path] = record;
			this.scheduleSave();
			this.plugin.updateStatusBar();

			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile && activeFile.path === file.path) {
				this.plugin.refreshSidebar();
			}

			return record;
		} catch (err) {
			console.error(`Lattice: Failed to index ${file.path}`, err);
			return null;
		}
	}

	/**
	 * Scans the entire vault incrementally (or forced rebuild).
	 */
	public async scanVault(forceRebuild = false): Promise<void> {
		if (this.isIndexing) {
			new Notice("Lattice: Vault indexing is already in progress.");
			return;
		}

		const online = await this.checkOllamaStatus(false);
		if (!online) {
			new Notice(
				"Lattice: Ollama is currently offline. Using cached vectors; live indexing paused."
			);
			return;
		}

		this.isIndexing = true;
		this.plugin.updateStatusBar();
		this.plugin.refreshSidebar();

		try {
			if (forceRebuild) {
				this.store = {};
			}

			const allFiles = this.app.vault.getMarkdownFiles();
			const validPaths = new Set<string>();
			const toIndex: TFile[] = [];

			for (const file of allFiles) {
				if (!this.shouldIndexFile(file)) continue;
				validPaths.add(file.path);

				const cached = this.store[file.path];
				if (
					forceRebuild ||
					!cached ||
					cached.mtime !== file.stat.mtime ||
					!cached.vector ||
					cached.vector.length === 0
				) {
					toIndex.push(file);
				}
			}

			// Prune deleted or newly excluded files
			let pruned = 0;
			for (const path of Object.keys(this.store)) {
				if (!validPaths.has(path)) {
					delete this.store[path];
					pruned++;
				}
			}

			let updated = 0;
			for (const file of toIndex) {
				const rec = await this.indexFile(file, forceRebuild);
				if (rec) updated++;
				if (!this.isOllamaOnline) {
					break;
				}
			}

			if (updated > 0 || pruned > 0 || forceRebuild) {
				await this.flushSave();
				new Notice(
					`Lattice: Indexed ${updated} note(s) (${this.getVectorCount()} total concepts cached).`
				);
			}
		} finally {
			this.isIndexing = false;
			this.plugin.updateStatusBar();
			this.plugin.refreshSidebar();
		}
	}

	/**
	 * Imports external vector updates from `.okf/vectors.json` produced by CLI agents
	 * (Claude Code, Python ingestion scripts, etc.) and triggers incremental delta scan.
	 */
	public async syncFromExternalCliCache(): Promise<number> {
		const sharedPath = normalizePath(this.plugin.settings.sharedVectorsPath);
		const adapter = this.app.vault.adapter;

		let importedCount = 0;
		if (await adapter.exists(sharedPath)) {
			try {
				const raw = await adapter.read(sharedPath);
				const parsed = JSON.parse(raw) as Record<string, VectorRecord>;
				if (parsed && typeof parsed === "object") {
					for (const [path, rec] of Object.entries(parsed)) {
						if (rec && Array.isArray(rec.vector) && rec.vector.length > 0) {
							const current = this.store[path];
							if (!current || rec.mtime >= current.mtime) {
								this.store[path] = {
									...rec,
									path,
									vector: normalizeVector(rec.vector),
								};
								importedCount++;
							}
						}
					}
				}
			} catch (err) {
				console.error("Lattice: Failed reading external CLI vector cache", err);
			}
		}

		await this.scanVault(false);
		this.plugin.refreshSidebar();
		return importedCount;
	}

	/**
	 * Debounces disk writes to `data.json` and `.okf/vectors.json`.
	 */
	private scheduleSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(async () => {
			this.saveTimer = null;
			await this.flushSave();
		}, 1500);
	}

	public async flushSave(): Promise<void> {
		await this.plugin.savePluginData();

		if (this.plugin.settings.exportSharedVectors) {
			await this.exportSharedVectorsFile();
		}
	}

	/**
	 * Writes the flat JSON vector cache to `.okf/vectors.json` for external CLI tools.
	 */
	public async exportSharedVectorsFile(): Promise<void> {
		try {
			const sharedPath = normalizePath(this.plugin.settings.sharedVectorsPath);
			const adapter = this.app.vault.adapter;
			const slashIdx = sharedPath.lastIndexOf("/");
			if (slashIdx > 0) {
				const dir = sharedPath.slice(0, slashIdx);
				if (!(await adapter.exists(dir))) {
					await adapter.mkdir(dir);
				}
			}
			await adapter.write(sharedPath, JSON.stringify(this.store, null, 2));
		} catch (err) {
			console.error("Lattice: Failed writing shared vectors file", err);
		}
	}

	public destroy(): void {
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
	}
}
