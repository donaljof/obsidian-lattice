import { App, Editor, MarkdownView, Notice, TFile, normalizePath, requestUrl } from "obsidian";
import { VectorIndexer } from "./indexer";
import type LatticePlugin from "./main";
import type {
	OKFFrontmatter,
	OKFStatus,
	OKFType,
	ScoredVectorRecord,
	VectorRecord,
} from "./settings";

export const VALID_OKF_TYPES: OKFType[] = [
	"Concept",
	"Spec",
	"Playbook",
	"Reference",
	"Seed",
];

export const VALID_OKF_STATUSES: OKFStatus[] = [
	"seed",
	"growing",
	"evergreen",
];

export interface OKFValidationResult {
	isValid: boolean;
	missingFields: string[];
	warnings: string[];
	frontmatter: OKFFrontmatter;
}

export interface UnlinkedMention {
	record: ScoredVectorRecord;
	matchedText: string;
	index: number;
}

export interface ConnectedNoteValidation {
	file: TFile;
	direction: "outgoing" | "incoming" | "both";
	validation: OKFValidationResult;
}

export interface ConnectedConformanceReport {
	noteFile: TFile;
	noteValidation: OKFValidationResult;
	connectedNotes: ConnectedNoteValidation[];
	validConnectedCount: number;
	invalidConnectedNotes: ConnectedNoteValidation[];
	unresolvedLinks: string[];
	allConformant: boolean;
}

export interface VaultConformanceSummary {
	totalNotes: number;
	validCount: number;
	invalidCount: number;
	invalidNotes: Array<{
		file: TFile;
		validation: OKFValidationResult;
	}>;
	durationMs: number;
}

export interface VaultDiscoveryReport {
	totalIndexableNotes: number;
	indexedNotes: number;
	staleOrUnindexedNotes: number;
	validOkfNotes: number;
	incompleteOkfNotes: number;
	orphanedVectorsPruned: number;
	dimensionMismatchesPruned: number;
	primaryVectorDimension: number | null;
	discoveredTypes: string[];
	discoveredStatuses: string[];
	topTags: string[];
	resolvedInboxFolder: string;
	issues: string[];
}

export class OKFManager {
	private app: App;
	private plugin: LatticePlugin;
	private cachedTypes: string[] | null = null;
	private cachedStatuses: string[] | null = null;
	private cachedTopTags: string[] = [];
	private lastDiscoveryReport: VaultDiscoveryReport | null = null;
	private lastVaultConformanceSummary: VaultConformanceSummary | null = null;

	constructor(app: App, plugin: LatticePlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	public getLastDiscoveryReport(): VaultDiscoveryReport | null {
		return this.lastDiscoveryReport;
	}

	public getLastVaultConformanceSummary(): VaultConformanceSummary | null {
		return this.lastVaultConformanceSummary;
	}

	/**
	 * Invalidates the in-memory schema discovery cache when note frontmatter changes.
	 */
	public invalidateDiscoveryCache(): void {
		this.cachedTypes = null;
		this.cachedStatuses = null;
	}

	/**
	 * Lightweight Startup Discovery & Consistency Check:
	 * Scans vault metadata cache and vector store in memory (<5ms, zero LLM calls) to:
	 * 1. Discover vault-specific `type`, `status`, and `tags` conventions (decoupling plugin from hardcoded schemas).
	 * 2. Auto-detect existing Inbox folder conventions if the default folder doesn't exist.
	 * 3. Prune orphaned vector records (deleted/excluded files) and mismatched vector dimensions.
	 * 4. Compute vault indexing & OKF consistency metrics.
	 */
	public async runStartupDiscovery(showNotice = false): Promise<VaultDiscoveryReport> {
		const typesMap = new Map<string, string>(); // lowercase -> canonical casing
		const statusesMap = new Map<string, string>();
		const tagCounts = new Map<string, number>();
		const issues: string[] = [];

		const store = this.plugin?.indexer?.getStore?.() || {};
		const allMarkdownFiles = this.app?.vault?.getMarkdownFiles?.() || [];
		const indexableFiles: TFile[] = [];
		const validPaths = new Set<string>();

		for (const file of allMarkdownFiles) {
			if (this.plugin?.indexer?.shouldIndexFile(file)) {
				indexableFiles.push(file);
				validPaths.add(file.path);
			}
		}

		// 1. Check vector store consistency: prune orphans & detect dimension mismatches
		let orphanedVectorsPruned = 0;
		const dimCounts = new Map<number, number>();

		for (const [path, rec] of Object.entries(store)) {
			if (!validPaths.has(path) || !rec || !Array.isArray(rec.vector) || rec.vector.length === 0) {
				delete store[path];
				orphanedVectorsPruned++;
				continue;
			}
			const dim = rec.vector.length;
			dimCounts.set(dim, (dimCounts.get(dim) || 0) + 1);

			if (rec.type && typeof rec.type === "string" && rec.type.trim()) {
				const trimmed = rec.type.trim();
				if (trimmed.toLowerCase() !== "log" && !typesMap.has(trimmed.toLowerCase())) {
					typesMap.set(trimmed.toLowerCase(), trimmed);
				}
			}
		}

		// Determine dominant vector dimension (e.g. 768 for nomic-embed-text)
		let primaryVectorDimension: number | null = null;
		let maxDimFreq = 0;
		for (const [dim, freq] of dimCounts.entries()) {
			if (freq > maxDimFreq) {
				maxDimFreq = freq;
				primaryVectorDimension = dim;
			}
		}

		let dimensionMismatchesPruned = 0;
		if (primaryVectorDimension !== null && dimCounts.size > 1) {
			for (const [path, rec] of Object.entries(store)) {
				if (rec.vector.length !== primaryVectorDimension) {
					delete store[path];
					dimensionMismatchesPruned++;
				}
			}
			issues.push(
				`Pruned ${dimensionMismatchesPruned} vector(s) with mismatched embedding dimensions (expected ${primaryVectorDimension}D).`
			);
		}

		if (orphanedVectorsPruned > 0) {
			issues.push(`Cleaned up ${orphanedVectorsPruned} orphaned vector cache record(s).`);
		}

		// 2. Scan vault frontmatter via metadataCache to discover types, statuses, and tags
		for (const file of indexableFiles) {
			const cache = this.app?.metadataCache?.getFileCache?.(file);
			const fm = cache?.frontmatter as OKFFrontmatter | undefined;
			if (!fm) continue;

			if (typeof fm.type === "string" && fm.type.trim()) {
				const t = fm.type.trim();
				if (t.toLowerCase() !== "log" && !typesMap.has(t.toLowerCase())) {
					typesMap.set(t.toLowerCase(), t);
				}
			}

			if (typeof fm.status === "string" && fm.status.trim()) {
				const s = fm.status.trim();
				if (!statusesMap.has(s.toLowerCase())) {
					statusesMap.set(s.toLowerCase(), s);
				}
			}

			const tags = VectorIndexer.normalizeTags(fm.tags);
			for (const tag of tags) {
				const lower = tag.toLowerCase();
				tagCounts.set(lower, (tagCounts.get(lower) || 0) + 1);
			}
		}

		// Fallback to canonical OKF defaults if the vault has no typed/status notes yet
		if (typesMap.size === 0) {
			for (const t of VALID_OKF_TYPES) {
				typesMap.set(t.toLowerCase(), t);
			}
		}
		if (statusesMap.size === 0) {
			for (const s of VALID_OKF_STATUSES) {
				statusesMap.set(s.toLowerCase(), s);
			}
		}

		this.cachedTypes = Array.from(typesMap.values()).sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" })
		);
		this.cachedStatuses = Array.from(statusesMap.values()).sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" })
		);
		this.cachedTopTags = Array.from(tagCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 15)
			.map(([tag]) => tag);

		// 3. Evaluate note indexing & OKF frontmatter completeness across the vault
		let indexedNotes = 0;
		let staleOrUnindexedNotes = 0;
		let validOkfNotes = 0;
		let incompleteOkfNotes = 0;

		for (const file of indexableFiles) {
			const rec = store[file.path];
			if (rec && rec.mtime === file.stat.mtime && rec.vector.length > 0) {
				indexedNotes++;
			} else {
				staleOrUnindexedNotes++;
			}

			const cache = this.app?.metadataCache?.getFileCache?.(file);
			const fm = (cache?.frontmatter || {}) as OKFFrontmatter;
			const val = OKFManager.validateFrontmatter(
				fm,
				this.cachedTypes,
				this.cachedStatuses
			);
			if (val.isValid) {
				validOkfNotes++;
			} else {
				incompleteOkfNotes++;
			}
		}

		// 4. Resolve Inbox folder (decouple from hardcoded 00_Inbox if vault uses another convention)
		let resolvedInboxFolder = this.plugin?.settings?.inboxFolder || "00_Inbox";
		if (this.app?.vault?.adapter?.exists) {
			const configuredExists = await this.app.vault.adapter.exists(
				normalizePath(resolvedInboxFolder)
			);
			if (!configuredExists && resolvedInboxFolder === "00_Inbox") {
				const candidates = [
					"Inbox",
					"00-Inbox",
					"_inbox",
					"01_Inbox",
					"Capture",
					"Fleeting",
				];
				for (const candidate of candidates) {
					if (await this.app.vault.adapter.exists(normalizePath(candidate))) {
						resolvedInboxFolder = candidate;
						this.plugin.settings.inboxFolder = candidate;
						issues.push(
							`Auto-detected existing vault inbox folder: "${candidate}/".`
						);
						break;
					}
				}
			}
		}

		if (
			orphanedVectorsPruned > 0 ||
			dimensionMismatchesPruned > 0
		) {
			await this.plugin?.indexer?.flushSave?.();
		}

		const report: VaultDiscoveryReport = {
			totalIndexableNotes: indexableFiles.length,
			indexedNotes,
			staleOrUnindexedNotes,
			validOkfNotes,
			incompleteOkfNotes,
			orphanedVectorsPruned,
			dimensionMismatchesPruned,
			primaryVectorDimension,
			discoveredTypes: this.cachedTypes,
			discoveredStatuses: this.cachedStatuses,
			topTags: this.cachedTopTags,
			resolvedInboxFolder,
			issues,
		};

		this.lastDiscoveryReport = report;

		if (showNotice) {
			const issueSuffix =
				issues.length > 0 ? ` (${issues.length} consistency fix(es) applied)` : "";
			new Notice(
				`Lattice Discovery: ${indexedNotes}/${indexableFiles.length} notes indexed, ${this.cachedTypes.length} note types [${this.cachedTypes.join(", ")}]${issueSuffix}.`
			);
		}

		return report;
	}

	/**
	 * Dynamically returns OKF types present across the vault and indexed records.
	 * Decouples the plugin from any single hardcoded note schema.
	 */
	public getDiscoveredTypes(): string[] {
		if (this.cachedTypes && this.cachedTypes.length > 0) {
			return this.cachedTypes;
		}

		const typesMap = new Map<string, string>();

		// 1. Collect from currently indexed store
		const store = this.plugin?.indexer?.getStore?.() || {};
		for (const rec of Object.values(store)) {
			if (rec.type && typeof rec.type === "string" && rec.type.trim()) {
				const t = rec.type.trim();
				if (t.toLowerCase() !== "log" && !typesMap.has(t.toLowerCase())) {
					typesMap.set(t.toLowerCase(), t);
				}
			}
		}

		// 2. Collect from vault markdown files via metadata cache
		if (this.app?.vault?.getMarkdownFiles && this.app?.metadataCache?.getFileCache) {
			const files = this.app.vault.getMarkdownFiles();
			for (const file of files) {
				const cache = this.app.metadataCache.getFileCache(file);
				const t = cache?.frontmatter?.type;
				if (typeof t === "string" && t.trim()) {
					const trimmed = t.trim();
					if (
						trimmed.toLowerCase() !== "log" &&
						!typesMap.has(trimmed.toLowerCase())
					) {
						typesMap.set(trimmed.toLowerCase(), trimmed);
					}
				}
			}
		}

		// 3. Fallback to default OKF types if vault has no typed notes yet
		if (typesMap.size === 0) {
			for (const t of VALID_OKF_TYPES) {
				typesMap.set(t.toLowerCase(), t);
			}
		}

		this.cachedTypes = Array.from(typesMap.values()).sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" })
		);
		return this.cachedTypes;
	}

	/**
	 * Dynamically returns statuses used across the vault, falling back to `seed | growing | evergreen`.
	 */
	public getDiscoveredStatuses(): string[] {
		if (this.cachedStatuses && this.cachedStatuses.length > 0) {
			return this.cachedStatuses;
		}

		const statusesMap = new Map<string, string>();
		if (this.app?.vault?.getMarkdownFiles && this.app?.metadataCache?.getFileCache) {
			const files = this.app.vault.getMarkdownFiles();
			for (const file of files) {
				const cache = this.app.metadataCache.getFileCache(file);
				const s = cache?.frontmatter?.status;
				if (typeof s === "string" && s.trim()) {
					const trimmed = s.trim();
					if (!statusesMap.has(trimmed.toLowerCase())) {
						statusesMap.set(trimmed.toLowerCase(), trimmed);
					}
				}
			}
		}

		if (statusesMap.size === 0) {
			for (const s of VALID_OKF_STATUSES) {
				statusesMap.set(s.toLowerCase(), s);
			}
		}

		this.cachedStatuses = Array.from(statusesMap.values()).sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" })
		);
		return this.cachedStatuses;
	}

	public getDiscoveredTags(): string[] {
		return this.cachedTopTags;
	}

	/**
	 * Validates a note's frontmatter against the vault's discovered OKF schema.
	 */
	public validateFile(file: TFile): OKFValidationResult {
		const cache = this.app?.metadataCache?.getFileCache?.(file);
		const fm = (cache?.frontmatter || {}) as OKFFrontmatter;
		return OKFManager.validateFrontmatter(
			fm,
			this.getDiscoveredTypes(),
			this.getDiscoveredStatuses()
		);
	}

	/**
	 * Post-Header-Change Verification (Note + Connected Notes):
	 * Pure in-memory (<0.5ms, zero disk I/O, zero LLM calls) check of `file` AND its
	 * outgoing linked notes + incoming backlinked notes via `app.metadataCache.resolvedLinks`.
	 */
	public verifyNoteAndConnectedConformance(
		file: TFile
	): ConnectedConformanceReport {
		const noteValidation = this.validateFile(file);
		const resolvedLinks: Record<string, Record<string, number>> =
			(this.app?.metadataCache as unknown as {
				resolvedLinks?: Record<string, Record<string, number>>;
			})?.resolvedLinks || {};
		const unresolvedLinksMap: Record<string, Record<string, number>> =
			(this.app?.metadataCache as unknown as {
				unresolvedLinks?: Record<string, Record<string, number>>;
			})?.unresolvedLinks || {};

		const directionMap = new Map<string, "outgoing" | "incoming" | "both">();

		// 1. Outgoing links from file.path
		const outgoingTargets = resolvedLinks[file.path] || {};
		for (const [targetPath, count] of Object.entries(outgoingTargets)) {
			if (count > 0 && targetPath !== file.path) {
				directionMap.set(targetPath, "outgoing");
			}
		}

		// 2. Incoming backlinks pointing to file.path
		for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
			if (sourcePath === file.path) continue;
			if (targets && targets[file.path] > 0) {
				const existing = directionMap.get(sourcePath);
				directionMap.set(
					sourcePath,
					existing === "outgoing" ? "both" : "incoming"
				);
			}
		}

		// Resolve TFile instances (with fallback to getMarkdownFiles() for unit tests)
		const mdFilesByPath = new Map<string, TFile>();
		if (!this.app?.vault?.getAbstractFileByPath && this.app?.vault?.getMarkdownFiles) {
			for (const f of this.app.vault.getMarkdownFiles()) {
				mdFilesByPath.set(f.path, f);
			}
		}

		const connectedNotes: ConnectedNoteValidation[] = [];
		const invalidConnectedNotes: ConnectedNoteValidation[] = [];
		let validConnectedCount = 0;

		for (const [connectedPath, direction] of directionMap.entries()) {
			let targetFile: TFile | null = null;
			if (this.app?.vault?.getAbstractFileByPath) {
				const abs = this.app.vault.getAbstractFileByPath(connectedPath);
				if (abs instanceof TFile) {
					targetFile = abs;
				}
			} else {
				targetFile = mdFilesByPath.get(connectedPath) || null;
			}

			if (!targetFile || targetFile.extension?.toLowerCase() !== "md") {
				continue;
			}
			if (
				this.plugin?.indexer &&
				!this.plugin.indexer.shouldIndexFile(targetFile)
			) {
				continue;
			}

			const validation = this.validateFile(targetFile);
			const entry: ConnectedNoteValidation = {
				file: targetFile,
				direction,
				validation,
			};
			connectedNotes.push(entry);
			if (validation.isValid) {
				validConnectedCount++;
			} else {
				invalidConnectedNotes.push(entry);
			}
		}

		// Sort connected notes so non-conformant ones appear first
		connectedNotes.sort((a, b) => {
			if (a.validation.isValid !== b.validation.isValid) {
				return a.validation.isValid ? 1 : -1;
			}
			return a.file.basename.localeCompare(b.file.basename);
		});

		const unresolvedLinks = Object.entries(unresolvedLinksMap[file.path] || {})
			.filter(([, count]) => count > 0)
			.map(([linkText]) => linkText);

		return {
			noteFile: file,
			noteValidation,
			connectedNotes,
			validConnectedCount,
			invalidConnectedNotes,
			unresolvedLinks,
			allConformant:
				noteValidation.isValid &&
				invalidConnectedNotes.length === 0 &&
				unresolvedLinks.length === 0,
		};
	}

	/**
	 * Ultra-Lightweight Full-Vault OKF Conformance Scan:
	 * Scans all indexable markdown notes in memory via `app.metadataCache` (<2ms, zero disk I/O, zero LLM calls).
	 */
	public scanVaultOKFConformance(showNotice = false): VaultConformanceSummary {
		const t0 =
			typeof performance !== "undefined" ? performance.now() : Date.now();
		const allFiles = this.app?.vault?.getMarkdownFiles?.() || [];
		const invalidNotes: Array<{
			file: TFile;
			validation: OKFValidationResult;
		}> = [];
		let totalNotes = 0;
		let validCount = 0;

		for (const file of allFiles) {
			if (
				this.plugin?.indexer &&
				!this.plugin.indexer.shouldIndexFile(file)
			) {
				continue;
			}
			totalNotes++;
			const validation = this.validateFile(file);
			if (validation.isValid) {
				validCount++;
			} else {
				invalidNotes.push({ file, validation });
			}
		}

		invalidNotes.sort((a, b) => {
			const diff =
				b.validation.missingFields.length -
				a.validation.missingFields.length;
			if (diff !== 0) return diff;
			return a.file.basename.localeCompare(b.file.basename);
		});

		const t1 =
			typeof performance !== "undefined" ? performance.now() : Date.now();
		const durationMs = Math.max(0.01, Number((t1 - t0).toFixed(2)));

		const summary: VaultConformanceSummary = {
			totalNotes,
			validCount,
			invalidCount: invalidNotes.length,
			invalidNotes,
			durationMs,
		};

		this.lastVaultConformanceSummary = summary;

		if (showNotice) {
			if (summary.invalidCount === 0) {
				new Notice(
					`Lattice OKF Check: All ${summary.totalNotes} notes are 100% OKF conformant (${summary.durationMs}ms).`
				);
			} else {
				new Notice(
					`Lattice OKF Check: ${summary.validCount}/${summary.totalNotes} notes conformant, ${summary.invalidCount} need OKF headers (${summary.durationMs}ms).`
				);
			}
		}

		return summary;
	}

	public static validateFrontmatter(
		fm: OKFFrontmatter,
		allowedTypes?: string[],
		allowedStatuses?: string[]
	): OKFValidationResult {
		const missingFields: string[] = [];
		const warnings: string[] = [];
		const knownTypes =
			allowedTypes && allowedTypes.length > 0 ? allowedTypes : VALID_OKF_TYPES;
		const knownStatuses =
			allowedStatuses && allowedStatuses.length > 0
				? allowedStatuses
				: VALID_OKF_STATUSES;

		if (!fm.type || typeof fm.type !== "string") {
			missingFields.push("type");
		} else if (
			!knownTypes.some(
				(t) => t.toLowerCase() === String(fm.type).trim().toLowerCase()
			)
		) {
			warnings.push(
				`Non-standard type "${fm.type}". Expected one of: ${knownTypes.join(" | ")}`
			);
		}

		if (!fm.title || typeof fm.title !== "string" || !fm.title.trim()) {
			missingFields.push("title");
		}

		if (
			!fm.description ||
			typeof fm.description !== "string" ||
			!fm.description.trim()
		) {
			missingFields.push("description");
		}

		const normalizedTags = VectorIndexer.normalizeTags(fm.tags);
		if (normalizedTags.length === 0) {
			missingFields.push("tags");
		}

		if (!fm.created) {
			missingFields.push("created");
		}

		if (!fm.status || typeof fm.status !== "string") {
			missingFields.push("status");
		} else if (
			!knownStatuses.some(
				(s) => s.toLowerCase() === String(fm.status).trim().toLowerCase()
			)
		) {
			warnings.push(
				`Non-standard status "${fm.status}". Expected: ${knownStatuses.join(" | ")}`
			);
		}

		return {
			isValid: missingFields.length === 0 && warnings.length === 0,
			missingFields,
			warnings,
			frontmatter: fm,
		};
	}

	/**
	 * Formats today's date as YYYY-MM-DD.
	 */
	public static todayISO(): string {
		const d = new Date();
		const yyyy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, "0");
		const dd = String(d.getDate()).padStart(2, "0");
		return `${yyyy}-${mm}-${dd}`;
	}

	/**
	 * Normalizes an OKF type against dynamically discovered vault types or defaults.
	 */
	public normalizeType(raw: unknown): string {
		return OKFManager.normalizeType(raw, this.getDiscoveredTypes());
	}

	public static normalizeType(raw: unknown, knownTypes?: string[]): string {
		const list =
			knownTypes && knownTypes.length > 0 ? knownTypes : VALID_OKF_TYPES;
		if (typeof raw !== "string" || !raw.trim()) return list[0] || "Concept";
		const trimmed = raw.trim();
		const match = list.find(
			(t) => t.toLowerCase() === trimmed.toLowerCase()
		);
		return match || trimmed;
	}

	/**
	 * Normalizes an OKF status against dynamically discovered vault statuses or defaults.
	 */
	public normalizeStatus(raw: unknown): string {
		return OKFManager.normalizeStatus(raw, this.getDiscoveredStatuses());
	}

	public static normalizeStatus(raw: unknown, knownStatuses?: string[]): string {
		const list =
			knownStatuses && knownStatuses.length > 0
				? knownStatuses
				: VALID_OKF_STATUSES;
		if (typeof raw !== "string" || !raw.trim()) return list[0] || "seed";
		const trimmed = raw.trim();
		const match = list.find(
			(s) => s.toLowerCase() === trimmed.toLowerCase()
		);
		return match || list[0] || "seed";
	}

	/**
	 * Command: `Lattice: Enrich OKF Frontmatter`
	 * Lifecycle-aware OKF header enrichment:
	 * - Post new-note creation: adds `type`, `title`, `description`, `tags`, `created`, and `status` based on note content.
	 * - Later in the note lifecycle (when content changes): updates `type`, `title`, `description`, `tags`, and `status`
	 *   to reflect the latest note content while preserving `created` and any custom YAML keys.
	 * - Immediately verifies OKF conformance of the note and its connected notes after updating headers.
	 */
	public async enrichNoteFrontmatter(
		file: TFile,
		refreshExisting = true
	): Promise<boolean> {
		const rawContent = await this.app.vault.read(file);
		const body = VectorIndexer.stripFrontmatter(rawContent);

		if (!body.trim()) {
			new Notice(
				"Lattice: Note body is empty; add content before enriching frontmatter."
			);
			return false;
		}

		const notice = new Notice(
			`Lattice: Generating OKF metadata for "${file.basename}"...`,
			0
		);

		try {
			const discoveredTypes = this.getDiscoveredTypes();
			const discoveredStatuses = this.getDiscoveredStatuses();
			const existingTagHints =
				this.cachedTopTags.length > 0
					? `Existing vault tags (reuse where appropriate): ${this.cachedTopTags.join(", ")}`
					: "";

			const prompt = [
				"You are an Open Knowledge Format (OKF) metadata generator for an Obsidian knowledge vault.",
				"Analyze the following note and return a strict JSON object with these keys:",
				`- "type": Must be one of ${discoveredTypes.map((t) => `"${t}"`).join(", ")}.`,
				'- "title": Clear, explicit concept title.',
				'- "description": Single-sentence high-signal summary of the atomic concept (max 160 chars).',
				'- "tags": Array of 2 to 5 normalized lowercase kebab-case domain tags.',
				`- "status": Must be one of ${discoveredStatuses.map((s) => `"${s}"`).join(", ")}.`,
				existingTagHints,
				"",
				`Note Filename: ${file.basename}`,
				"Note Content:",
				body.slice(0, 6000),
			]
				.filter(Boolean)
				.join("\n");

			const response = await requestUrl({
				url: `${this.plugin.settings.ollamaUrl}/api/generate`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.plugin.settings.chatModel,
					prompt,
					format: "json",
					stream: false,
				}),
				throw: false,
			});

			if (response.status !== 200 || !response.json?.response) {
				notice.hide();
				new Notice(
					`Lattice: Ollama metadata generation failed (status ${response.status}). Check if ${this.plugin.settings.chatModel} is pulled.`
				);
				return false;
			}

			let generated: Partial<OKFFrontmatter> = {};
			try {
				generated = JSON.parse(response.json.response);
			} catch {
				notice.hide();
				new Notice("Lattice: Failed to parse JSON from Ollama response.");
				return false;
			}

			const cleanTags = VectorIndexer.normalizeTags(generated.tags)
				.map((t) =>
					t
						.toLowerCase()
						.replace(/[^a-z0-9-_]/g, "-")
						.replace(/-+/g, "-")
						.replace(/^-|-$/g, "")
				)
				.filter(Boolean)
				.slice(0, 5);

			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (refreshExisting || !fm.type) {
					fm.type = this.normalizeType(generated.type);
				}
				if (refreshExisting || !fm.title) {
					fm.title =
						typeof generated.title === "string" && generated.title.trim()
							? generated.title.trim()
							: file.basename;
				}
				if (refreshExisting || !fm.description) {
					fm.description =
						typeof generated.description === "string" &&
						generated.description.trim()
							? generated.description.trim()
							: `Atomic note covering ${file.basename}.`;
				}
				const existingTags = VectorIndexer.normalizeTags(fm.tags);
				if (refreshExisting || existingTags.length === 0) {
					fm.tags = cleanTags.length > 0 ? cleanTags : ["untagged"];
				}
				if (!fm.created) {
					fm.created = OKFManager.todayISO();
				}
				if (refreshExisting || !fm.status) {
					fm.status = this.normalizeStatus(generated.status);
				}
			});

			this.invalidateDiscoveryCache();
			const connectedReport = this.verifyNoteAndConnectedConformance(file);
			notice.hide();

			const connectedSuffix =
				connectedReport.connectedNotes.length > 0
					? ` | Connected: ${connectedReport.validConnectedCount}/${connectedReport.connectedNotes.length} OKF valid`
					: "";
			new Notice(
				`Lattice: Updated OKF headers for "${file.basename}"${connectedSuffix}.`
			);

			// Re-index immediately with the enriched OKF metadata
			await this.plugin.indexer.indexFile(file, true);
			this.plugin.refreshSidebar();
			return true;
		} catch (err) {
			notice.hide();
			console.error("Lattice: Error enriching frontmatter", err);
			new Notice(
				`Lattice: Cannot reach Ollama at ${this.plugin.settings.ollamaUrl}.`
			);
			return false;
		}
	}

	/**
	 * Batch-enriches all notes in the configured Inbox folder that are missing required OKF frontmatter.
	 */
	public async enrichInboxFolder(): Promise<number> {
		const inboxPrefix = this.plugin.settings.inboxFolder.replace(/^\/+|\/+$/g, "");
		const files = this.app.vault.getMarkdownFiles().filter((f) => {
			return (
				this.plugin.indexer.shouldIndexFile(f) &&
				(f.path.startsWith(inboxPrefix + "/") || f.parent?.path === inboxPrefix)
			);
		});

		if (files.length === 0) {
			new Notice(`Lattice: No markdown notes found in ${inboxPrefix}/`);
			return 0;
		}

		let enrichedCount = 0;
		for (const file of files) {
			const validation = this.validateFile(file);
			if (!validation.isValid) {
				const ok = await this.enrichNoteFrontmatter(file, false);
				if (ok) enrichedCount++;
			}
		}

		new Notice(
			`Lattice: Enriched ${enrichedCount} of ${files.length} note(s) in ${inboxPrefix}/.`
		);
		return enrichedCount;
	}

	/**
	 * Checks whether `rawContent` already contains a [[WikiLink]] to `record`.
	 */
	public isConceptLinkedInContent(
		rawContent: string,
		record: VectorRecord
	): boolean {
		const cleanPath = record.path.replace(/\.md$/i, "");
		const basename = cleanPath.replace(/^.*\//, "");
		const candidates = [cleanPath, basename, record.title]
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);

		const wikiRegex = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
		let match: RegExpExecArray | null;
		while ((match = wikiRegex.exec(rawContent)) !== null) {
			const target = match[1].trim().replace(/\.md$/i, "").toLowerCase();
			if (candidates.includes(target)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 1-Click Cross-Linker:
	 * Connects `record` to `file` with a single click regardless of editor focus or view mode:
	 * 1. If `record.title` appears as an unlinked mention in the note body, converts it in-place to `[[path|Title]]`.
	 * 2. Otherwise, appends `record` to the `> [!info] Related Concepts` section at the bottom of `file`
	 *    (creating the callout block if not present, or adding a line to the existing block).
	 */
	public async crossLinkConcept(
		file: TFile,
		record: ScoredVectorRecord | VectorRecord
	): Promise<boolean> {
		const rawContent = await this.app.vault.read(file);
		if (this.isConceptLinkedInContent(rawContent, record)) {
			new Notice(`Lattice: "${record.title}" is already linked in "${file.basename}".`);
			return false;
		}

		const scored: ScoredVectorRecord =
			"similarity" in record ? record : { ...record, similarity: 1 };

		// 1. Check if there's a natural unlinked mention in the note prose
		const mentions = this.findUnlinkedMentions(rawContent, [scored]);
		if (mentions.length > 0) {
			return await this.convertMentionToWikiLink(file, mentions[0]);
		}

		// 2. Otherwise, add to the `> [!info] Related Concepts` callout block at the bottom of the note
		const cleanPath = record.path.replace(/\.md$/i, "");
		const pct =
			"similarity" in record
				? ` (${Math.round(record.similarity * 100)}%)`
				: "";
		const descSuffix = record.description ? ` — ${record.description}` : "";
		const bulletLine = `> - **[${record.type || "Concept"}]** [[${cleanPath}|${record.title}]]${pct}${descSuffix}`;

		await this.app.vault.process(file, (content) => {
			const calloutHeader = "> [!info] Related Concepts";
			const headerIdx = content.indexOf(calloutHeader);
			if (headerIdx !== -1) {
				const afterHeader = content.slice(headerIdx);
				const lines = afterHeader.split("\n");
				let insertLineOffset = 1;
				while (
					insertLineOffset < lines.length &&
					lines[insertLineOffset].trim().startsWith(">")
				) {
					insertLineOffset++;
				}
				lines.splice(insertLineOffset, 0, bulletLine);
				return content.slice(0, headerIdx) + lines.join("\n");
			}

			return (
				content.trimEnd() +
				"\n\n" +
				calloutHeader +
				"\n" +
				bulletLine +
				"\n"
			);
		});

		new Notice(`Lattice: Cross-linked [[${record.title}]] in "${file.basename}".`);
		return true;
	}

	/**
	 * Inserts `[[path/to/note|Title]]` at the current cursor position in the active or target note's editor.
	 * Resolves the MarkdownView leaf even when clicking the sidebar stole focus.
	 */
	public async insertWikiLinkAtCursor(
		record: VectorRecord,
		targetFile?: TFile,
		editor?: Editor
	): Promise<boolean> {
		let activeEditor = editor || this.app.workspace.activeEditor?.editor;

		// If clicking the sidebar stole focus, locate the MarkdownView leaf for targetFile
		if (!activeEditor) {
			const mdLeaves = this.app.workspace.getLeavesOfType("markdown");
			for (const leaf of mdLeaves) {
				const view = leaf.view;
				if (
					view instanceof MarkdownView &&
					(!targetFile || view.file?.path === targetFile.path)
				) {
					activeEditor = view.editor;
					break;
				}
			}
		}

		if (activeEditor) {
			const cleanPath = record.path.replace(/\.md$/i, "");
			const wikiLink = `[[${cleanPath}|${record.title}]]`;
			activeEditor.replaceSelection(wikiLink);
			new Notice(`Lattice: Inserted [[${record.title}]] at cursor.`);
			return true;
		}

		// Fallback if note is in Reading view: cross-link directly into file
		if (targetFile) {
			return await this.crossLinkConcept(targetFile, record);
		}

		new Notice("Lattice: Open a markdown note to insert a link.");
		return false;
	}

	/**
	 * Command: `Lattice: Insert Related OKF Concepts`
	 * Appends all unlinked top neighbors into the `> [!info] Related Concepts` callout block.
	 */
	public async appendRelatedCallout(
		file: TFile,
		neighbors: ScoredVectorRecord[]
	): Promise<void> {
		if (neighbors.length === 0) {
			new Notice("Lattice: No related OKF concepts found for this note.");
			return;
		}

		const rawContent = await this.app.vault.read(file);
		const unlinkedNeighbors = neighbors.filter(
			(n) => !this.isConceptLinkedInContent(rawContent, n)
		);

		if (unlinkedNeighbors.length === 0) {
			new Notice("Lattice: All top related concepts are already linked in this note.");
			return;
		}

		for (const n of unlinkedNeighbors) {
			await this.crossLinkConcept(file, n);
		}
	}

	/**
	 * Scans active note prose for unlinked mentions of top semantic neighbors.
	 * Ignores YAML frontmatter and existing `[[WikiLinks]]`.
	 */
	public findUnlinkedMentions(
		rawContent: string,
		neighbors: ScoredVectorRecord[]
	): UnlinkedMention[] {
		const body = VectorIndexer.stripFrontmatter(rawContent);
		if (!body) return [];

		// Mask out existing [[...]] WikiLinks and markdown links so we don't match inside them
		const maskedBody = body.replace(/\[\[[^\]]+\]\]/g, (match) =>
			" ".repeat(match.length)
		);

		const mentions: UnlinkedMention[] = [];

		for (const neighbor of neighbors) {
			const candidateTerms = [
				neighbor.title,
				neighbor.path.replace(/^.*\//, "").replace(/\.md$/i, ""),
			].filter((t) => t && t.length >= 3);

			const uniqueTerms = Array.from(new Set(candidateTerms));
			for (const term of uniqueTerms) {
				const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const regex = new RegExp(`\\b${escaped}\\b`, "i");
				const match = regex.exec(maskedBody);
				if (match && match.index !== undefined) {
					mentions.push({
						record: neighbor,
						matchedText: match[0],
						index: match.index,
					});
					break;
				}
			}
		}

		return mentions;
	}

	/**
	 * Converts the first unlinked mention of `mention.record` in `file` into a `[[WikiLink]]`.
	 */
	public async convertMentionToWikiLink(
		file: TFile,
		mention: UnlinkedMention
	): Promise<boolean> {
		let replaced = false;
		const cleanPath = mention.record.path.replace(/\.md$/i, "");

		await this.app.vault.process(file, (rawContent) => {
			let frontmatterPart = "";
			let bodyPart = rawContent;

			if (rawContent.startsWith("---")) {
				const endMatch = rawContent.indexOf("\n---", 3);
				if (endMatch !== -1) {
					const afterFence = rawContent.indexOf("\n", endMatch + 4);
					if (afterFence !== -1) {
						frontmatterPart = rawContent.slice(0, afterFence + 1);
						bodyPart = rawContent.slice(afterFence + 1);
					}
				}
			}

			const masked = bodyPart.replace(/\[\[[^\]]+\]\]/g, (m) =>
				" ".repeat(m.length)
			);
			const escaped = mention.matchedText.replace(
				/[.*+?^${}()|[\]\\]/g,
				"\\$&"
			);
			const regex = new RegExp(`\\b${escaped}\\b`, "i");
			const match = regex.exec(masked);

			if (!match || match.index === undefined) {
				return rawContent;
			}

			const actualText = bodyPart.slice(
				match.index,
				match.index + match[0].length
			);
			const wikiLink = `[[${cleanPath}|${actualText}]]`;
			const updatedBody =
				bodyPart.slice(0, match.index) +
				wikiLink +
				bodyPart.slice(match.index + match[0].length);

			replaced = true;
			return frontmatterPart + updatedBody;
		});

		if (replaced) {
			new Notice(
				`Lattice: Linked "${mention.matchedText}" → [[${cleanPath}]]`
			);
		}
		return replaced;
	}

	/**
	 * Updates or creates `index.md` at the vault root with a structured OKF catalog
	 * grouped by discovered `type`.
	 */
	public async updateVaultIndexFile(): Promise<void> {
		const store = this.plugin.indexer.getStore();
		const records = Object.values(store).sort((a, b) =>
			a.title.localeCompare(b.title)
		);

		const discovered = this.getDiscoveredTypes();
		const groups: Record<string, VectorRecord[]> = {};
		for (const t of discovered) {
			groups[t] = [];
		}

		for (const rec of records) {
			const normType = this.normalizeType(rec.type);
			if (!groups[normType]) {
				groups[normType] = [];
			}
			groups[normType].push(rec);
		}

		const lines: string[] = [
			"# Open Knowledge Format (OKF) Vault Catalog",
			"",
			`> Auto-generated by **Lattice** on ${OKFManager.todayISO()} (${records.length} indexed notes).`,
			"",
		];

		for (const type of Object.keys(groups)) {
			const items = groups[type] || [];
			if (items.length === 0) continue;

			lines.push(`## ${type} (${items.length})`);
			lines.push("");
			for (const item of items) {
				const cleanPath = item.path.replace(/\.md$/i, "");
				const desc = item.description ? ` — ${item.description}` : "";
				lines.push(`- [[${cleanPath}|${item.title}]]${desc}`);
			}
			lines.push("");
		}

		const indexPath = "index.md";
		const existing = this.app.vault.getAbstractFileByPath(indexPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, lines.join("\n"));
		} else {
			await this.app.vault.create(indexPath, lines.join("\n"));
		}

		new Notice("Lattice: Updated vault index.md with OKF catalog.");
	}
}
