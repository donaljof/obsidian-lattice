import { App, Editor, MarkdownView, Notice, TFile, normalizePath, requestUrl } from "obsidian";
import { VectorIndexer } from "./indexer";
import type LatticePlugin from "./main";
import { toKebabSlug } from "./path-utils";
import type {
	OKFFrontmatter,
	OKFType,
	ScoredVectorRecord,
	VectorRecord,
} from "./settings";

export const VALID_OKF_TYPES: OKFType[] = [
	"note",
	"paper",
	"topic",
	"project",
];

export const SOURCE_TYPE_ALIASES = new Set([
	"paper",
	"source",
	"book",
	"web",
	"transcript",
	"email",
	"dataset",
	"reference",
]);

export const NOTE_TYPE_ALIASES = new Set([
	"note",
	"spec",
	"concept",
	"seed",
	"playbook",
	"journal",
]);

export const HUB_OKF_TYPES = new Set([
	"topic",
	"project",
]);

export const OKF_TYPE_FOLDER_MAP: Record<string, string> = {
	note: "notes",
	paper: "sources/literature",
	topic: "topics",
	project: "projects",
};

export const ISO_TIMESTAMP_REGEX =
	/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const NUMERIC_TITLE_REGEX = /^\d{8,14}$/;
export const PLACEHOLDER_TAGS = new Set([
	"inbox",
	"origin/thought",
	"origin-thought",
	"untagged",
]);

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
	isAsymmetricHub: boolean;
}

export interface ConnectedConformanceReport {
	noteFile: TFile;
	noteValidation: OKFValidationResult;
	connectedNotes: ConnectedNoteValidation[];
	validConnectedCount: number;
	invalidConnectedNotes: ConnectedNoteValidation[];
	asymmetricHubNotes: ConnectedNoteValidation[];
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
	inboxNotes: Array<{
		file: TFile;
		validation: OKFValidationResult;
	}>;
	orphanNotes: TFile[];
	asymmetricLinks: Array<{
		sourceFile: TFile;
		hubFile: TFile;
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
	resolvedInboxFolder: string;
	issues: string[];
}

export class OKFManager {
	private app: App;
	private plugin: LatticePlugin;
	private cachedTypes: string[] | null = null;
	private cachedTypeFolderMap: Record<string, string> | null = null;
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
		this.cachedTypeFolderMap = null;
	}

	/**
	 * Lightweight Startup Discovery & Consistency Check:
	 * Scans vault metadata cache and vector store in memory (<5ms, zero LLM calls) to:
	 * 1. Normalize note types to the 4 core types (`note`, `paper`, `topic`, `project`).
	 * 2. Auto-detect existing Inbox folder conventions if the default folder doesn't exist.
	 * 3. Prune orphaned vector records (deleted/excluded files) and mismatched vector dimensions.
	 * 4. Compute vault indexing & OKF consistency metrics.
	 */
	public async runStartupDiscovery(showNotice = false): Promise<VaultDiscoveryReport> {
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

		// 2. Discover folder-backed OKF types from existing vault folders + baseline settings
		const discoveredMap: Record<string, string> = {
			...OKF_TYPE_FOLDER_MAP,
			...(this.plugin?.settings?.typeFolderMap || {}),
		};

		for (const file of indexableFiles) {
			if (this.isNoteInInbox(file)) continue;
			const normPath = file.path.replace(/^\/+/, "");
			const slashIdx = normPath.indexOf("/");
			if (slashIdx <= 0) continue; // Only learn from organized subfolders

			const cache = this.app?.metadataCache?.getFileCache?.(file);
			const rawType = cache?.frontmatter?.type;
			if (
				typeof rawType === "string" &&
				/^[a-z][a-z0-9_-]*$/i.test(rawType.trim())
			) {
				const lower = rawType.trim().toLowerCase();
				if (
					!discoveredMap[lower] &&
					!SOURCE_TYPE_ALIASES.has(lower) &&
					!NOTE_TYPE_ALIASES.has(lower)
				) {
					const topFolder = normPath.slice(0, slashIdx);
					discoveredMap[lower] = topFolder;
				}
			}
		}

		this.cachedTypeFolderMap = discoveredMap;
		this.cachedTypes = Object.keys(discoveredMap);

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
			const val = OKFManager.validateFrontmatter(fm, this.cachedTypes);
			if (val.isValid) {
				validOkfNotes++;
			} else {
				incompleteOkfNotes++;
			}
		}

		// 3. Resolve Inbox folder
		let resolvedInboxFolder = this.plugin?.settings?.inboxFolder || "inbox";
		if (this.app?.vault?.adapter?.exists) {
			const configuredExists = await this.app.vault.adapter.exists(
				normalizePath(resolvedInboxFolder)
			);
			if (
				!configuredExists &&
				(resolvedInboxFolder === "inbox" ||
					resolvedInboxFolder === "00_Inbox")
			) {
				const candidates = [
					"inbox",
					"Inbox",
					"00_Inbox",
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
			resolvedInboxFolder,
			issues,
		};

		this.lastDiscoveryReport = report;

		if (showNotice) {
			const issueSuffix =
				issues.length > 0 ? ` (${issues.length} consistency fix(es) applied)` : "";
			new Notice(
				`Lattice Discovery: ${indexedNotes}/${indexableFiles.length} notes indexed (${validOkfNotes} OKF conformant)${issueSuffix}.`
			);
		}

		return report;
	}

	/**
	 * Returns the active `type -> folder` routing map (4 core defaults + any folder-backed types discovered in the vault).
	 */
	public getTypeFolderMap(): Record<string, string> {
		if (this.cachedTypeFolderMap) {
			return this.cachedTypeFolderMap;
		}
		this.cachedTypeFolderMap = {
			...OKF_TYPE_FOLDER_MAP,
			...(this.plugin?.settings?.typeFolderMap || {}),
		};
		return this.cachedTypeFolderMap;
	}

	/**
	 * Returns the active folder-aligned OKF types for this vault (defaults to `note`, `paper`, `topic`, `project`).
	 */
	public getDiscoveredTypes(): string[] {
		if (this.cachedTypes && this.cachedTypes.length > 0) {
			return this.cachedTypes;
		}
		this.cachedTypes = Object.keys(this.getTypeFolderMap());
		return this.cachedTypes;
	}

	/**
	 * Validates a note's frontmatter against the 4-type, 5-field OKF schema.
	 * Enforces `okf_validate.py` reserved-file rule: `log.md` must have NO frontmatter.
	 */
	public validateFile(file: TFile): OKFValidationResult {
		const cache = this.app?.metadataCache?.getFileCache?.(file);
		if (file.name.toLowerCase() === "log.md") {
			const hasFm = Boolean(
				cache?.frontmatter && Object.keys(cache.frontmatter).length > 0
			);
			return {
				isValid: !hasFm,
				missingFields: [],
				warnings: hasFm ? ["log.md must have no frontmatter"] : [],
				frontmatter: (cache?.frontmatter || {}) as OKFFrontmatter,
			};
		}
		const fm = (cache?.frontmatter || {}) as OKFFrontmatter;
		return OKFManager.validateFrontmatter(fm, this.getDiscoveredTypes());
	}

	/**
	 * Checks whether `file` is located inside the configured `inbox/` staging folder.
	 */
	public isNoteInInbox(file: TFile): boolean {
		const inboxPrefix = (this.plugin?.settings?.inboxFolder || "inbox")
			.replace(/^\/+|\/+$/g, "")
			.toLowerCase();
		const normPath = file.path.replace(/^\/+/, "").toLowerCase();
		return (
			normPath.startsWith(inboxPrefix + "/") ||
			normPath.startsWith("inbox/")
		);
	}

	/**
	 * Returns the canonical folder (`notes`, `sources/literature`, `topics`, `projects`, etc.)
	 * for a given OKF `type` using the vault's discovered `type -> folder` map.
	 */
	public getTargetFolderForType(type: unknown): string {
		const lower = typeof type === "string" ? type.trim().toLowerCase() : "note";
		const map = this.getTypeFolderMap();
		return map[lower] || map.note || "notes";
	}

	/**
	 * Post-Header-Change Verification (Note + Connected Notes + Asymmetric Hub Check):
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
		const fileNorm = file.path.replace(/^\/+/, "");

		// 1. Outgoing links from file.path
		const outgoingTargets =
			resolvedLinks[file.path] || resolvedLinks["/" + fileNorm] || {};
		for (const [rawTarget, count] of Object.entries(outgoingTargets)) {
			const targetPath = rawTarget.replace(/^\/+/, "");
			if (count > 0 && targetPath !== fileNorm) {
				directionMap.set(targetPath, "outgoing");
			}
		}

		// 2. Incoming backlinks pointing to file.path
		for (const [rawSource, targets] of Object.entries(resolvedLinks)) {
			const sourcePath = rawSource.replace(/^\/+/, "");
			if (sourcePath === fileNorm || !targets) continue;
			if ((targets[fileNorm] || targets["/" + fileNorm] || 0) > 0) {
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
				mdFilesByPath.set(f.path.replace(/^\/+/, ""), f);
			}
		}

		const connectedNotes: ConnectedNoteValidation[] = [];
		const invalidConnectedNotes: ConnectedNoteValidation[] = [];
		const asymmetricHubNotes: ConnectedNoteValidation[] = [];
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
			const targetType = String(validation.frontmatter.type || "")
				.trim()
				.toLowerCase();
			// okf_lint.py ASYMMETRIC rule: concept links a hub (topic/org/place/project/role) that does not link back
			const isAsymmetricHub =
				direction === "outgoing" && HUB_OKF_TYPES.has(targetType);

			const entry: ConnectedNoteValidation = {
				file: targetFile,
				direction,
				validation,
				isAsymmetricHub,
			};
			connectedNotes.push(entry);
			if (validation.isValid) {
				validConnectedCount++;
			} else {
				invalidConnectedNotes.push(entry);
			}
			if (isAsymmetricHub) {
				asymmetricHubNotes.push(entry);
			}
		}

		// Sort connected notes so non-conformant or asymmetric hubs appear first
		connectedNotes.sort((a, b) => {
			if (a.validation.isValid !== b.validation.isValid) {
				return a.validation.isValid ? 1 : -1;
			}
			if (a.isAsymmetricHub !== b.isAsymmetricHub) {
				return a.isAsymmetricHub ? -1 : 1;
			}
			return a.file.basename.localeCompare(b.file.basename);
		});

		const unresolvedLinks = Object.entries(
			unresolvedLinksMap[file.path] ||
				unresolvedLinksMap["/" + fileNorm] ||
				{}
		)
			.filter(([, count]) => count > 0)
			.map(([linkText]) => linkText);

		return {
			noteFile: file,
			noteValidation,
			connectedNotes,
			validConnectedCount,
			invalidConnectedNotes,
			asymmetricHubNotes,
			unresolvedLinks,
			allConformant:
				noteValidation.isValid &&
				invalidConnectedNotes.length === 0 &&
				asymmetricHubNotes.length === 0 &&
				unresolvedLinks.length === 0,
		};
	}

	/**
	 * Ultra-Lightweight Full-Vault OKF Conformance & Graph Lint Scan (`okf_validate.py` + `okf_lint.py`):
	 * Scans all indexable markdown notes in memory via `app.metadataCache` (<2ms, zero disk I/O, zero LLM calls).
	 */
	public scanVaultOKFConformance(showNotice = false): VaultConformanceSummary {
		const t0 =
			typeof performance !== "undefined" ? performance.now() : Date.now();
		const allFiles = this.app?.vault?.getMarkdownFiles?.() || [];
		const resolvedLinks: Record<string, Record<string, number>> =
			(this.app?.metadataCache as unknown as {
				resolvedLinks?: Record<string, Record<string, number>>;
			})?.resolvedLinks || {};

		const invalidNotes: Array<{
			file: TFile;
			validation: OKFValidationResult;
		}> = [];
		const inboxNotes: Array<{
			file: TFile;
			validation: OKFValidationResult;
		}> = [];

		const indexableByPath = new Map<string, TFile>();
		const typeByPath = new Map<string, string>();
		let totalNotes = 0;
		let validCount = 0;

		for (const file of allFiles) {
			if (
				this.plugin?.indexer &&
				!this.plugin.indexer.shouldIndexFile(file)
			) {
				continue;
			}
			const normPath = file.path.replace(/^\/+/, "");
			const inInbox = this.isNoteInInbox(file);
			const validation = this.validateFile(file);

			if (inInbox) {
				if (!validation.isValid) {
					inboxNotes.push({ file, validation });
				} else {
					totalNotes++;
					validCount++;
				}
				continue;
			}

			totalNotes++;
			indexableByPath.set(normPath, file);
			typeByPath.set(
				normPath,
				String(validation.frontmatter.type || "").trim().toLowerCase()
			);

			if (validation.isValid) {
				validCount++;
			} else {
				invalidNotes.push({ file, validation });
			}
		}

		// Graph Lint (in-memory ORPHAN & ASYMMETRIC checks from okf_lint.py)
		const inboundCount = new Map<string, number>();
		const asymmetricLinks: Array<{ sourceFile: TFile; hubFile: TFile }> = [];

		for (const normPath of indexableByPath.keys()) {
			inboundCount.set(normPath, 0);
		}

		for (const [rawSrc, targets] of Object.entries(resolvedLinks)) {
			const srcPath = rawSrc.replace(/^\/+/, "");
			const srcFile = indexableByPath.get(srcPath);
			if (!srcFile || !targets) continue;

			for (const [rawTgt, count] of Object.entries(targets)) {
				if (count <= 0) continue;
				const tgtPath = rawTgt.replace(/^\/+/, "");
				if (tgtPath === srcPath) continue;
				const tgtFile = indexableByPath.get(tgtPath);
				if (!tgtFile) continue;

				inboundCount.set(tgtPath, (inboundCount.get(tgtPath) || 0) + 1);

				const tgtType = typeByPath.get(tgtPath) || "";
				if (HUB_OKF_TYPES.has(tgtType)) {
					const reverseTargets =
						resolvedLinks[tgtPath] ||
						resolvedLinks["/" + tgtPath] ||
						{};
					const linksBack =
						(reverseTargets[srcPath] ||
							reverseTargets["/" + srcPath] ||
							0) > 0;
					if (!linksBack) {
						asymmetricLinks.push({
							sourceFile: srcFile,
							hubFile: tgtFile,
						});
					}
				}
			}
		}

		const orphanNotes: TFile[] = [];
		if (Object.keys(resolvedLinks).length > 0) {
			for (const [normPath, file] of indexableByPath.entries()) {
				if (normPath.toLowerCase() === "topics/overview.md") continue;
				if ((inboundCount.get(normPath) || 0) === 0) {
					orphanNotes.push(file);
				}
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
			inboxNotes,
			orphanNotes,
			asymmetricLinks,
			durationMs,
		};

		this.lastVaultConformanceSummary = summary;

		if (showNotice) {
			const inboxSuffix =
				inboxNotes.length > 0
					? `, ${inboxNotes.length} in inbox/`
					: "";
			if (summary.invalidCount === 0) {
				new Notice(
					`Lattice OKF Check: All ${summary.totalNotes} concepts are OKF conformant${inboxSuffix} (${summary.durationMs}ms).`
				);
			} else {
				new Notice(
					`Lattice OKF Check: ${summary.validCount}/${summary.totalNotes} conformant, ${summary.invalidCount} error(s)${inboxSuffix} (${summary.durationMs}ms).`
				);
			}
		}

		return summary;
	}

	/**
	 * Validates frontmatter against the simplified 4-type (`note`, `paper`, `topic`, `project`),
	 * 5-field (`type`, `title`, `description`, `tags`, `timestamp`) OKF schema:
	 * - Flags missing core fields (`type`, `title`, `description`, `tags`, `timestamp`).
	 * - Flags legacy header drift (`created`, `origin`, `status`), placeholder tags (`inbox`, `origin/thought`),
	 *   and raw numeric timestamp titles (e.g. `"202610261411"`).
	 */
	public static validateFrontmatter(
		fm: OKFFrontmatter,
		allowedTypes?: string[]
	): OKFValidationResult {
		const missingFields: string[] = [];
		const warnings: string[] = [];
		const knownTypes =
			allowedTypes && allowedTypes.length > 0
				? allowedTypes
				: VALID_OKF_TYPES;

		if (!fm.type || typeof fm.type !== "string" || !fm.type.trim()) {
			missingFields.push("type");
		} else {
			const typeStr = String(fm.type).trim().toLowerCase();
			const matchesKnown =
				knownTypes.some((t) => t.toLowerCase() === typeStr) ||
				VALID_OKF_TYPES.some((t) => t.toLowerCase() === typeStr) ||
				SOURCE_TYPE_ALIASES.has(typeStr);
			if (!matchesKnown) {
				warnings.push(
					`Non-standard type "${fm.type}". Expected one of: ${VALID_OKF_TYPES.join(" | ")}`
				);
			}
		}

		if (!fm.title || typeof fm.title !== "string" || !fm.title.trim()) {
			missingFields.push("title");
		} else if (NUMERIC_TITLE_REGEX.test(fm.title.trim())) {
			warnings.push(
				`Title "${fm.title}" is a raw timestamp slug (click Enrich OKF to generate a human title)`
			);
		}

		if (
			!fm.description ||
			typeof fm.description !== "string" ||
			!fm.description.trim()
		) {
			missingFields.push("description");
		}

		const normalizedTags = VectorIndexer.normalizeTags(fm.tags);
		const meaningfulTags = normalizedTags.filter(
			(t) => !PLACEHOLDER_TAGS.has(t.toLowerCase())
		);
		if (normalizedTags.length === 0) {
			missingFields.push("tags");
		} else if (meaningfulTags.length === 0) {
			warnings.push(
				"Only placeholder capture tags (`inbox`, `origin/thought`) present"
			);
		}

		if (!fm.timestamp) {
			missingFields.push("timestamp");
		} else if (
			typeof fm.timestamp === "string" &&
			!ISO_TIMESTAMP_REGEX.test(fm.timestamp.trim())
		) {
			warnings.push(`Timestamp "${fm.timestamp}" is not ISO 8601.`);
		}

		const legacyKeys = ["created", "origin", "status"].filter(
			(k) => fm[k] !== undefined && fm[k] !== null && String(fm[k]).trim() !== ""
		);
		if (legacyKeys.length > 0) {
			warnings.push(
				`Redundant legacy header key(s): ${legacyKeys.join(", ")}`
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
	 * Formats current UTC timestamp as ISO 8601 (`YYYY-MM-DDTHH:mm:ssZ`), matching `meta/okf-spec.md`.
	 */
	public static nowISOUTC(): string {
		return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	}

	/**
	 * Converts a concept title into a lowercase kebab-case slug per `meta/okf-spec.md`.
	 */
	public static toKebabSlug(raw: string): string {
		return toKebabSlug(raw);
	}

	/**
	 * Normalizes an OKF type into one of the vault's active folder-aligned types.
	 */
	public normalizeType(raw: unknown): string {
		if (typeof raw === "string" && raw.trim()) {
			const lower = raw.trim().toLowerCase();
			const map = this.getTypeFolderMap();
			if (map[lower]) return lower;
		}
		return OKFManager.normalizeType(raw);
	}

	public static normalizeType(raw: unknown): string {
		if (typeof raw !== "string" || !raw.trim()) return "note";
		const lower = raw.trim().toLowerCase();
		if (lower === "topic") return "topic";
		if (lower === "project") return "project";
		if (SOURCE_TYPE_ALIASES.has(lower)) return "paper";
		if (NOTE_TYPE_ALIASES.has(lower)) return "note";
		const match = VALID_OKF_TYPES.find((t) => t.toLowerCase() === lower);
		return match || "note";
	}

	/**
	 * Command: `Lattice: Enrich OKF Frontmatter`
	 * Lifecycle-aware 5-field OKF header enrichment (`type`, `title`, `description`, `tags`, `timestamp`):
	 * - Generates tags strictly from the note's own prose (never injecting unrelated vault-wide tags).
	 * - Deterministically guards `type` so personal notes are never misclassified as `paper`.
	 * - Strips redundant legacy header keys (`created`, `origin`, `status`) and placeholder tags (`inbox`, `origin/thought`).
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
			const cache = this.app?.metadataCache?.getFileCache?.(file);
			const existingFm = (cache?.frontmatter || {}) as OKFFrontmatter;
			const normPath = file.path.replace(/^\/+/, "").toLowerCase();
			const isExternalSource =
				normPath.startsWith("sources/") ||
				Boolean(existingFm.resource || existingFm.doi || existingFm.authors);

			const isNumericFilename = NUMERIC_TITLE_REGEX.test(file.basename.trim());
			const filenameHint = isNumericFilename
				? "(Filename is a numeric timestamp; derive a descriptive human title from the Note Content below)"
				: `Note Filename: ${file.basename}`;

			const prompt = [
				"You are an Open Knowledge Format (OKF) metadata generator for an Obsidian knowledge vault.",
				"Analyze ONLY the Note Content below and return a strict JSON object with these 4 keys:",
				'- "type": Must be one of "note", "paper", "topic", "project".',
				'  * Use "note" (default) for personal notes, ideas, learnings, plans, or syntheses.',
				'  * Use "paper" ONLY if the note summarizes an external published paper, book, or article.',
				'  * Use "topic" ONLY if the note is a Map-of-Content hub indexing multiple notes.',
				'  * Use "project" ONLY if the note tracks a specific project.',
				'- "title": Clear, human-readable concept title (never use a numeric timestamp as the title).',
				'- "description": Single-sentence high-signal summary of the note (max 160 chars).',
				'- "tags": Array of 2 to 4 lowercase kebab-case tags derived STRICTLY from the topics in this note (do NOT invent unrelated science or chemistry tags).',
				"",
				filenameHint,
				"Note Content:",
				body.slice(0, 6000),
			].join("\n");

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
				.filter((t) => Boolean(t) && !PLACEHOLDER_TAGS.has(t))
				.slice(0, 4);

			// Deterministic type guard: prevent personal notes from being misclassified as `paper`
			let resolvedType = this.normalizeType(generated.type);
			if (normPath.startsWith("projects/")) {
				resolvedType = "project";
			} else if (normPath.startsWith("topics/") && existingFm.type === "topic") {
				resolvedType = "topic";
			} else if (isExternalSource) {
				resolvedType = "paper";
			} else if (resolvedType === "paper" && !isExternalSource) {
				resolvedType = "note";
			}

			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (refreshExisting || !fm.type) {
					fm.type = resolvedType;
				}
				const existingTitle =
					typeof fm.title === "string" ? fm.title.trim() : "";
				if (
					refreshExisting ||
					!existingTitle ||
					NUMERIC_TITLE_REGEX.test(existingTitle)
				) {
					const candidateTitle =
						typeof generated.title === "string" &&
						generated.title.trim() &&
						!NUMERIC_TITLE_REGEX.test(generated.title.trim())
							? generated.title.trim()
							: !isNumericFilename
							? file.basename
							: "Untitled Note";
					fm.title = candidateTitle;
				}
				if (refreshExisting || !fm.description) {
					fm.description =
						typeof generated.description === "string" &&
						generated.description.trim()
							? generated.description.trim()
							: `Atomic note covering ${String(fm.title || file.basename)}.`;
				}
				const existingTags = VectorIndexer.normalizeTags(fm.tags).filter(
					(t) => !PLACEHOLDER_TAGS.has(t.toLowerCase())
				);
				if (refreshExisting || existingTags.length === 0) {
					fm.tags =
						cleanTags.length > 0
							? cleanTags
							: existingTags.length > 0
							? existingTags
							: ["note"];
				}
				// Canonical 5th field: ISO 8601 UTC timestamp
				fm.timestamp = OKFManager.nowISOUTC();

				// Strip redundant legacy header fields so all notes share the clean 5-field header
				delete fm.created;
				delete fm.origin;
				delete fm.status;
			});

			this.invalidateDiscoveryCache();
			const connectedReport = this.verifyNoteAndConnectedConformance(file);
			notice.hide();

			const connectedSuffix =
				connectedReport.connectedNotes.length > 0
					? ` | Connected: ${connectedReport.validConnectedCount}/${connectedReport.connectedNotes.length} OKF valid`
					: "";
			new Notice(
				`Lattice: Normalized OKF headers for "${file.basename}"${connectedSuffix}.`
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
	 * Appends a newest-first entry to the vault root `log.md` (matching `meta/tools/okf_log.py`).
	 * `log.md` is a reserved OKF file and carries NO frontmatter.
	 */
	public async appendLogEntry(
		operation: string,
		description: string
	): Promise<void> {
		const date = OKFManager.todayISO();
		const entry = `## [${date}] ${operation} | ${description}`;
		const defaultHeader =
			"# Log\n\nAppend-only operation history, newest first. Maintained by `meta/tools/okf_log.py`.\n";

		const logPath = "log.md";
		const existing = this.app?.vault?.getAbstractFileByPath?.(logPath);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, (content) => {
				const lines = content.split(/\r?\n/);
				const entryRegex = /^## \[?\d{4}-\d{2}-\d{2}/;
				let splitIdx = -1;
				for (let i = 0; i < lines.length; i++) {
					if (entryRegex.test(lines[i])) {
						splitIdx = i;
						break;
					}
				}
				if (splitIdx !== -1) {
					const header =
						lines.slice(0, splitIdx).join("\n").trimEnd() ||
						defaultHeader.trimEnd();
					const entries = lines.slice(splitIdx).join("\n").trimEnd();
					return `${header}\n\n${entry}\n\n${entries}\n`;
				}
				const header = content.trimEnd() || defaultHeader.trimEnd();
				return `${header}\n\n${entry}\n`;
			});
		} else if (this.app?.vault?.create) {
			await this.app.vault.create(
				logPath,
				`${defaultHeader}\n${entry}\n`
			);
		}
	}

	/**
	 * 1-Click `okf-refactor` Filing Helper:
	 * Moves an enriched note from `inbox/` into its canonical OKF folder (`notes/`, `sources/web/`, `topics/`, `projects/`, etc.)
	 * with a lowercase kebab-case filename derived from its title, and logs the operation in `log.md`.
	 */
	public async fileNoteFromInbox(file: TFile): Promise<TFile | null> {
		const validation = this.validateFile(file);
		const type = this.normalizeType(validation.frontmatter.type || "note");
		const targetFolder = normalizePath(this.getTargetFolderForType(type));
		const rawTitle =
			typeof validation.frontmatter.title === "string" &&
			validation.frontmatter.title.trim()
				? validation.frontmatter.title.trim()
				: file.basename;
		const slug = OKFManager.toKebabSlug(rawTitle) || OKFManager.toKebabSlug(file.basename) || "note";

		if (
			this.app.vault.adapter?.exists &&
			!(await this.app.vault.adapter.exists(targetFolder))
		) {
			await this.app.vault.createFolder(targetFolder);
		}

		let newPath = normalizePath(`${targetFolder}/${slug}.md`);
		let counter = 1;
		while (
			newPath !== file.path &&
			this.app.vault.adapter?.exists &&
			(await this.app.vault.adapter.exists(newPath))
		) {
			newPath = normalizePath(`${targetFolder}/${slug}-${counter}.md`);
			counter++;
		}

		const oldPath = file.path;
		if (newPath !== oldPath) {
			await this.app.fileManager.renameFile(file, newPath);
		}

		await this.appendLogEntry(
			"refactor",
			`${slug}: filed from ${oldPath} -> /${newPath} (type: ${type})`
		);

		new Notice(`Lattice: Filed note to /${newPath}`);
		this.plugin.refreshSidebar();
		return file;
	}

	/**
	 * Checks whether `rawContent` already contains a bundle-relative Markdown link `[...](/path.md)`
	 * OR a `[[WikiLink]]` to `record`.
	 */
	public isConceptLinkedInContent(
		rawContent: string,
		record: VectorRecord
	): boolean {
		const normPath = record.path.replace(/^\/+/, "");
		const cleanPath = normPath.replace(/\.md$/i, "");
		const basename = cleanPath.replace(/^.*\//, "");
		const candidates = [
			normPath.toLowerCase(),
			"/" + normPath.toLowerCase(),
			cleanPath.toLowerCase(),
			"/" + cleanPath.toLowerCase(),
			basename.toLowerCase(),
			record.title.trim().toLowerCase(),
		].filter(Boolean);

		// 1. Check bundle-relative Markdown links: [label](/path/to/note.md) or [label](path/to/note.md)
		const mdLinkRegex = /\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g;
		let match: RegExpExecArray | null;
		while ((match = mdLinkRegex.exec(rawContent)) !== null) {
			const rawTarget = decodeURIComponent(match[1].trim()).toLowerCase();
			const strippedTarget = rawTarget.replace(/^\/+/, "").replace(/\.md$/i, "");
			if (
				candidates.includes(rawTarget) ||
				candidates.includes(strippedTarget)
			) {
				return true;
			}
		}

		// 2. Check [[WikiLinks]]
		const wikiRegex = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
		while ((match = wikiRegex.exec(rawContent)) !== null) {
			const target = match[1]
				.trim()
				.replace(/^\/+/, "")
				.replace(/\.md$/i, "")
				.toLowerCase();
			if (candidates.includes(target)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Appends a bundle-relative Markdown link `- [Title](/path.md) — description` into `file`
	 * under `## Related` (matching `meta/templates/note.md`), or inside `> [!info] Related Concepts` if present.
	 */
	private async appendConceptLinkToFile(
		file: TFile,
		record: VectorRecord | ScoredVectorRecord
	): Promise<void> {
		const normPath = record.path.replace(/^\/+/, "");
		const mdPath = normPath.endsWith(".md") ? normPath : `${normPath}.md`;
		const descSuffix = record.description ? ` — ${record.description}` : "";
		const mdBullet = `- [${record.title}](/${mdPath})${descSuffix}`;

		await this.app.vault.process(file, (content) => {
			// If note already has a `## Related` heading, append under it
			const relatedHeadingRegex = /^##\s+Related\b.*$/m;
			const headingMatch = relatedHeadingRegex.exec(content);
			if (headingMatch && headingMatch.index !== undefined) {
				const afterHeadingIdx =
					headingMatch.index + headingMatch[0].length;
				const before = content.slice(0, afterHeadingIdx);
				const after = content.slice(afterHeadingIdx);
				// Replace an empty placeholder bullet `- ` if present right below `## Related`
				if (/^\r?\n-\s*(\r?\n|$)/.test(after)) {
					return (
						before +
						after.replace(/^\r?\n-\s*(\r?\n|$)/, `\n${mdBullet}$1`)
					);
				}
				return `${before}\n${mdBullet}${after}`;
			}

			// Fallback: if note uses `> [!info] Related Concepts` callout
			const calloutHeader = "> [!info] Related Concepts";
			const headerIdx = content.indexOf(calloutHeader);
			if (headerIdx !== -1) {
				const calloutBullet = `> - [${record.title}](/${mdPath})${descSuffix}`;
				const afterHeader = content.slice(headerIdx);
				const lines = afterHeader.split("\n");
				let insertLineOffset = 1;
				while (
					insertLineOffset < lines.length &&
					lines[insertLineOffset].trim().startsWith(">")
				) {
					insertLineOffset++;
				}
				lines.splice(insertLineOffset, 0, calloutBullet);
				return content.slice(0, headerIdx) + lines.join("\n");
			}

			return `${content.trimEnd()}\n\n## Related\n${mdBullet}\n`;
		});
	}

	/**
	 * 1-Click Reciprocal Link Helper (`okf_lint.py` ASYMMETRIC fix):
	 * Adds a bundle-relative link pointing to `sourceFile` inside `targetHubFile`.
	 */
	public async addReciprocalLink(
		sourceFile: TFile,
		targetHubFile: TFile
	): Promise<boolean> {
		const hubContent = await this.app.vault.read(targetHubFile);
		const sourceVal = this.validateFile(sourceFile);
		const sourceRecord: VectorRecord = this.plugin?.indexer?.getRecord?.(
			sourceFile.path
		) || {
			path: sourceFile.path,
			title:
				typeof sourceVal.frontmatter.title === "string" &&
				sourceVal.frontmatter.title.trim()
					? sourceVal.frontmatter.title.trim()
					: sourceFile.basename,
			mtime: sourceFile.stat.mtime,
			type: String(sourceVal.frontmatter.type || "note"),
			description: String(sourceVal.frontmatter.description || ""),
			tags: VectorIndexer.normalizeTags(sourceVal.frontmatter.tags),
			vector: [],
		};

		if (this.isConceptLinkedInContent(hubContent, sourceRecord)) {
			return false;
		}

		await this.appendConceptLinkToFile(targetHubFile, sourceRecord);
		new Notice(
			`Lattice: Added reciprocal link to [${sourceRecord.title}](/${sourceFile.path}) in "${targetHubFile.basename}".`
		);
		return true;
	}

	/**
	 * 1-Click Cross-Linker (`meta/okf-spec.md` & `AGENTS.md` Rule #7):
	 * Connects `record` to `file` with a single click using bundle-relative Markdown links `[Title](/path.md)`:
	 * 1. If `record.title` appears as an unlinked mention in the note body, converts it in-place to `[Title](/path.md)`.
	 * 2. Otherwise, appends `- [Title](/path.md) — description` under `## Related`.
	 * 3. If `record` is a Hub (`topic`, `project`, `org`, `place`, `role`), also adds the reciprocal link on the hub
	 *    so the graph remains symmetric (`okf_lint.py` ASYMMETRIC rule).
	 */
	public async crossLinkConcept(
		file: TFile,
		record: ScoredVectorRecord | VectorRecord,
		addReciprocalIfHub = true
	): Promise<boolean> {
		const rawContent = await this.app.vault.read(file);
		if (this.isConceptLinkedInContent(rawContent, record)) {
			new Notice(
				`Lattice: "${record.title}" is already linked in "${file.basename}".`
			);
			return false;
		}

		const scored: ScoredVectorRecord =
			"similarity" in record ? record : { ...record, similarity: 1 };

		// 1. Check if there's a natural unlinked mention in the note prose
		const mentions = this.findUnlinkedMentions(rawContent, [scored]);
		let linked = false;
		if (mentions.length > 0) {
			linked = await this.convertMentionToWikiLink(file, mentions[0]);
		} else {
			// 2. Otherwise, append under `## Related`
			await this.appendConceptLinkToFile(file, record);
			linked = true;
		}

		// 3. If target is a Hub (topic, project, org, place, role), ensure reciprocal backlink
		const recType = String(record.type || "").trim().toLowerCase();
		if (
			linked &&
			addReciprocalIfHub &&
			HUB_OKF_TYPES.has(recType) &&
			this.app?.vault?.getAbstractFileByPath
		) {
			const hubFile = this.app.vault.getAbstractFileByPath(
				record.path.replace(/^\/+/, "")
			);
			if (hubFile instanceof TFile && hubFile.path !== file.path) {
				await this.addReciprocalLink(file, hubFile);
			}
		}

		if (linked && mentions.length === 0) {
			new Notice(
				`Lattice: Cross-linked [${record.title}](/${record.path.replace(/^\/+/, "")}) in "${file.basename}".`
			);
		}
		return linked;
	}

	/**
	 * Inserts a bundle-relative Markdown link `[Title](/path/to/note.md)` at the current cursor position
	 * in the active or target note's editor. Resolves the MarkdownView leaf even when clicking the sidebar stole focus.
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
			const normPath = record.path.replace(/^\/+/, "");
			const mdPath = normPath.endsWith(".md") ? normPath : `${normPath}.md`;
			const mdLink = `[${record.title}](/${mdPath})`;
			activeEditor.replaceSelection(mdLink);
			new Notice(`Lattice: Inserted ${mdLink} at cursor.`);
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
	 * Appends all unlinked top neighbors into `## Related` using bundle-relative Markdown links.
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
			new Notice(
				"Lattice: All top related concepts are already linked in this note."
			);
			return;
		}

		for (const n of unlinkedNeighbors) {
			await this.crossLinkConcept(file, n);
		}
	}

	/**
	 * Scans active note prose for unlinked mentions of top semantic neighbors.
	 * Ignores YAML frontmatter and existing `[...](...)` Markdown links / `[[WikiLinks]]`.
	 */
	public findUnlinkedMentions(
		rawContent: string,
		neighbors: ScoredVectorRecord[]
	): UnlinkedMention[] {
		const body = VectorIndexer.stripFrontmatter(rawContent);
		if (!body) return [];

		// Mask out existing [[...]] WikiLinks and [...](...) Markdown links so we don't match inside them
		const maskedBody = body
			.replace(/\[\[[^\]]+\]\]/g, (match) => " ".repeat(match.length))
			.replace(/\[[^\]]*\]\([^)]+\)/g, (match) =>
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
	 * Converts the first unlinked mention of `mention.record` in `file` into a bundle-relative Markdown link `[text](/path.md)`.
	 */
	public async convertMentionToWikiLink(
		file: TFile,
		mention: UnlinkedMention
	): Promise<boolean> {
		let replaced = false;
		const normPath = mention.record.path.replace(/^\/+/, "");
		const mdPath = normPath.endsWith(".md") ? normPath : `${normPath}.md`;

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

			const masked = bodyPart
				.replace(/\[\[[^\]]+\]\]/g, (m) => " ".repeat(m.length))
				.replace(/\[[^\]]*\]\([^)]+\)/g, (m) => " ".repeat(m.length));
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
			const mdLink = `[${actualText}](/${mdPath})`;
			const updatedBody =
				bodyPart.slice(0, match.index) +
				mdLink +
				bodyPart.slice(match.index + match[0].length);

			replaced = true;
			return frontmatterPart + updatedBody;
		});

		if (replaced) {
			new Notice(
				`Lattice: Linked "${mention.matchedText}" → [/${mdPath}]`
			);
		}
		return replaced;
	}

	/**
	 * Updates or creates `index.md` at the vault root with a structured OKF catalog
	 * grouped by discovered `type` using bundle-relative Markdown links.
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
				const normPath = item.path.replace(/^\/+/, "");
				const mdPath = normPath.endsWith(".md") ? normPath : `${normPath}.md`;
				const desc = item.description ? ` — ${item.description}` : "";
				lines.push(`- [${item.title}](/${mdPath})${desc}`);
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
