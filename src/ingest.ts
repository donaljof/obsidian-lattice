import {
	App,
	Modal,
	Notice,
	TFile,
	normalizePath,
} from "obsidian";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractDocument, type ExtractedDocument } from "./extractors";
import { synthesizeWithLLM, type OKFSynthesisResult } from "./llm";
import type LatticePlugin from "./main";
import { findRelatedConcepts } from "./math";
import { OKFManager } from "./okf";
import { resolvePortableResourceUri, toKebabSlug } from "./path-utils";
import { OKF_TYPE_FOLDER_MAP } from "./okf";

export interface IngestOptions {
	preferredType?: string;
	customTags?: string[];
	forceTopicHub?: boolean;
	buffer?: ArrayBuffer | Uint8Array;
	filename?: string;
}

export class LatticeIngestModal extends Modal {
	protected plugin: LatticePlugin;
	private pathOrUrlInput = "";
	private selectedType = "paper";
	private forceTopicHub = false;
	private customTagsInput = "";
	private pendingBuffer: ArrayBuffer | null = null;
	private pendingFileName = "";

	constructor(app: App, plugin: LatticePlugin, initialUrl = "") {
		super(app);
		this.plugin = plugin;
		this.pathOrUrlInput = initialUrl;
		if (initialUrl) {
			this.selectedType = "paper";
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Lattice — Ingest Source or Topic" });
		contentEl.createEl("p", {
			text: "Automated AI knowledge loader. Accepts PPTX (with presenter notes), Word DOCX, PDF, web URLs, or directories. Synthesizes OKF-compliant concepts with portable resource links and graph cross-linking.",
			cls: "setting-item-description",
		});

		const form = contentEl.createDiv({ cls: "lattice-modal-form" });

		// Input Mode 1: Path or URL
		const pathRow = form.createDiv({ cls: "lattice-modal-row" });
		pathRow.createEl("label", { text: "File Path, Folder Path, or URL" });
		const pathInputEl = pathRow.createEl("input", {
			type: "text",
			placeholder: "e.g. C:/Presentations/deck.pptx, /path/to/papers/, or https://...",
		});
		pathInputEl.value = this.pathOrUrlInput;
		pathInputEl.addEventListener("input", (e) => {
			this.pathOrUrlInput = (e.target as HTMLInputElement).value.trim();
			this.autoDetectTypeFromPath(this.pathOrUrlInput);
		});

		// Native File Picker & Folder Picker
		const pickerRow = form.createDiv({ cls: "lattice-modal-row" });
		pickerRow.createEl("label", { text: "Or Select File on Disk" });
		const fileInputEl = pickerRow.createEl("input", {
			type: "file",
			cls: "lattice-file-input",
		});
		fileInputEl.accept = ".pdf,.docx,.pptx,.txt,.md";
		fileInputEl.addEventListener("change", async (e) => {
			const files = (e.target as HTMLInputElement).files;
			if (files && files.length > 0) {
				const file = files[0];
				this.pendingFileName = file.name;
				this.pathOrUrlInput = (file as unknown as { path?: string }).path || file.name;
				pathInputEl.value = this.pathOrUrlInput;
				this.pendingBuffer = await file.arrayBuffer();
				this.autoDetectTypeFromPath(file.name);
				submitBtn.setText(`Ingest "${file.name}"`);
			}
		});

		// Drag and Drop Zone
		const dropZone = form.createDiv({ cls: "lattice-dropzone" });
		dropZone.createEl("p", { text: "📁 Drag and drop PPTX, DOCX, or PDF files directly here" });
		dropZone.addEventListener("dragover", (e) => {
			e.preventDefault();
			dropZone.addClass("is-dragover");
		});
		dropZone.addEventListener("dragleave", () => {
			dropZone.removeClass("is-dragover");
		});
		dropZone.addEventListener("drop", async (e) => {
			e.preventDefault();
			dropZone.removeClass("is-dragover");
			const dt = e.dataTransfer;
			if (dt && dt.files && dt.files.length > 0) {
				const file = dt.files[0];
				this.pendingFileName = file.name;
				this.pathOrUrlInput = (file as unknown as { path?: string }).path || file.name;
				pathInputEl.value = this.pathOrUrlInput;
				this.pendingBuffer = await file.arrayBuffer();
				this.autoDetectTypeFromPath(file.name);
				submitBtn.setText(`Ingest "${file.name}"`);
			}
		});

		// Target OKF Concept Type
		const typeRow = form.createDiv({ cls: "lattice-modal-row" });
		typeRow.createEl("label", { text: "Target OKF Type" });
		const typeSelect = typeRow.createEl("select");
		const discoveredTypes = this.plugin.okf.getDiscoveredTypes();
		const availableTypes = discoveredTypes.length > 0 ? discoveredTypes : ["note", "paper", "topic", "project"];

		for (const t of availableTypes) {
			const opt = typeSelect.createEl("option", { text: t, value: t });
			if (t.toLowerCase() === this.selectedType.toLowerCase()) opt.selected = true;
		}
		typeSelect.addEventListener("change", (e) => {
			this.selectedType = (e.target as HTMLSelectElement).value;
		});

		// Scope Option (Topic Hub vs Concept)
		const scopeRow = form.createDiv({ cls: "lattice-modal-row" });
		const scopeLabel = scopeRow.createEl("label");
		const scopeCheckbox = scopeLabel.createEl("input", { type: "checkbox" });
		scopeCheckbox.checked = this.forceTopicHub;
		scopeLabel.appendChild(document.createTextNode(" Synthesize as a curated Topic Hub in topics/"));
		scopeCheckbox.addEventListener("change", (e) => {
			this.forceTopicHub = (e.target as HTMLInputElement).checked;
			if (this.forceTopicHub) {
				typeSelect.value = "topic";
				this.selectedType = "topic";
			}
		});

		// Optional Tags Row
		const tagsRow = form.createDiv({ cls: "lattice-modal-row" });
		tagsRow.createEl("label", { text: "Additional Tags (comma-separated)" });
		const tagsInputEl = tagsRow.createEl("input", {
			type: "text",
			placeholder: "e.g. materials-science, spectroscopy, rag",
		});
		tagsInputEl.addEventListener("input", (e) => {
			this.customTagsInput = (e.target as HTMLInputElement).value;
		});

		// Footer Buttons
		const footer = form.createDiv({ cls: "lattice-modal-footer" });
		const cancelBtn = footer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const submitBtn = footer.createEl("button", {
			cls: "mod-cta",
			text: "Ingest to OKF Vault",
		});

		const triggerSubmit = async () => {
			const input = this.pathOrUrlInput.trim();
			if (!input && !this.pendingBuffer) {
				new Notice("Lattice: Please provide a file path, directory path, or URL.");
				return;
			}

			submitBtn.disabled = true;
			submitBtn.setText("Analyzing with AI...");

			try {
				const tags = this.customTagsInput
					.split(",")
					.map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-"))
					.filter(Boolean);

				const loader = new LatticeKnowledgeLoader(this.app, this.plugin);
				const createdFiles = await loader.ingestTarget(input, {
					preferredType: this.selectedType,
					customTags: tags,
					forceTopicHub: this.forceTopicHub,
					buffer: this.pendingBuffer || undefined,
					filename: this.pendingFileName || undefined,
				});

				this.close();
				if (createdFiles && createdFiles.length > 0) {
					await this.app.workspace.getLeaf(false).openFile(createdFiles[0]);
				}
			} catch (err) {
				console.error("Lattice Ingestion Error:", err);
				new Notice(`Lattice: Ingestion failed — ${String(err)}`);
			} finally {
				submitBtn.disabled = false;
				submitBtn.setText("Ingest to OKF Vault");
			}
		};

		submitBtn.addEventListener("click", triggerSubmit);
		pathInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void triggerSubmit();
			}
		});

		setTimeout(() => pathInputEl.focus(), 50);
	}

	private autoDetectTypeFromPath(pathOrUrl: string): void {
		const lower = pathOrUrl.toLowerCase();
		if (
			/^https?:\/\//i.test(lower) ||
			lower.endsWith(".pptx") ||
			lower.endsWith(".docx") ||
			lower.endsWith(".pdf")
		) {
			this.selectedType = "paper";
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.pendingBuffer = null;
	}
}

/**
 * Backward compatibility alias for the URL Ingestion modal.
 */
export class UrlIngestModal extends LatticeIngestModal {
	constructor(app: App, plugin: LatticePlugin) {
		super(app, plugin);
	}
}

/**
 * Core Knowledge Loader Engine executing Pass 1 (extraction & synthesis)
 * and Pass 2 (graph cross-linking & topic hub integration).
 */
export class LatticeKnowledgeLoader {
	private app: App;
	private plugin: LatticePlugin;

	constructor(app: App, plugin: LatticePlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	public async ingestTarget(
		target: string,
		options: IngestOptions = {}
	): Promise<TFile[]> {
		// 1. Check if target is a local directory
		if (!/^https?:\/\//i.test(target) && !options.buffer) {
			try {
				const stat = await fs.stat(target);
				if (stat.isDirectory()) {
					return await this.ingestDirectory(target, options);
				}
			} catch {
				// Not a directory or buffer provided, continue as single file/URL
			}
		}

		// 2. Single Document or URL Ingestion
		const file = await this.ingestSingleDocument(target, options);
		return file ? [file] : [];
	}

	/**
	 * Ingests a single document or URL.
	 */
	public async ingestSingleDocument(
		target: string,
		options: IngestOptions = {}
	): Promise<TFile | null> {
		const progress = new Notice(`Lattice: Extracting ${target.split(/[\\/]/).pop()}...`, 0);

		try {
			// Step 1: Read buffer if local file and not already in options
			let dataBuffer = options.buffer;
			let resolvedPath = target;

			if (!dataBuffer && !/^https?:\/\//i.test(target)) {
				try {
					const fileBuffer = await fs.readFile(target);
					dataBuffer = fileBuffer;
				} catch (err) {
					progress.hide();
					new Notice(`Lattice: Could not read file "${target}" on disk.`);
					return null;
				}
			}

			// Step 2: Extract text & structure
			const extracted = await extractDocument(resolvedPath, dataBuffer);
			if (!extracted || !extracted.rawText.trim()) {
				progress.hide();
				new Notice(`Lattice: No extractable text found in "${target}".`);
				return null;
			}

			// Step 3: Compute Portable Cloud-Root Resource URI
			const vaultBasePath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath;
			const resourceUri = resolvePortableResourceUri(
				resolvedPath,
				vaultBasePath,
				this.plugin.settings.customCloudRoot
			);

			// Step 4: Check Deduplication (prevent duplicate notes for same resource)
			const existingFile = this.findExistingNoteForResource(resourceUri, extracted.title);
			if (existingFile) {
				progress.hide();
				new Notice(`Lattice: Note already exists for this resource: "${existingFile.path}".`);
				return existingFile;
			}

			// Step 5: Find Related Concepts in Vault for Semantic Cross-linking
			progress.setMessage("Lattice: Finding semantic neighbors in vault...");
			const snippet = `Title: ${extracted.title}\n\n${extracted.rawText.slice(0, 3000)}`;
			const queryVector = await this.plugin.indexer.fetchEmbedding(snippet);

			const relatedRecords = queryVector
				? findRelatedConcepts(
						queryVector,
						this.plugin.indexer.getStore(),
						{
							topK: Math.min(3, this.plugin.settings.topK),
							threshold: this.plugin.settings.similarityThreshold,
							headerBoostWeight: this.plugin.settings.headerBoostWeight ?? 0.15,
							queryTitle: extracted.title,
							queryTags: options.customTags,
							strictAutoLink: true,
						}
				  )
				: [];

			const contextLinks = relatedRecords.map((r) => {
				const cleanPath = r.path.replace(/^\/+/, "");
				return `[${r.title}](/${cleanPath}) (${r.description || r.type})`;
			});

			// Step 6: AI Synthesis (Pass 1)
			progress.setMessage("Lattice: Synthesizing OKF concept with AI...");
			const discoveredTypes = this.plugin.okf.getDiscoveredTypes();
			const synthesis = await synthesizeWithLLM(
				{
					sourceIdentifier: resourceUri,
					extractedTitle: extracted.title,
					rawContent: extracted.formattedMarkdown || extracted.rawText,
					preferredType: options.preferredType || "paper",
					existingConceptsContext: contextLinks.join("\n"),
					isTopicHub: options.forceTopicHub,
				},
				this.plugin.settings,
				discoveredTypes
			);

			// Step 7: Pass 2 — Integrate with Topic Hub & Graph using synthesized OKF headers
			const finalType = this.plugin.okf.normalizeType(synthesis.type);
			const finalTitle = synthesis.title || extracted.title;
			const finalDesc = synthesis.description || `Extracted reference from ${resourceUri}.`;
			const userTags = options.customTags || [];
			const mergedTags = Array.from(new Set([...synthesis.tags, ...userTags])).slice(0, 7);

			const verifiedRelated = queryVector
				? findRelatedConcepts(
						queryVector,
						this.plugin.indexer.getStore(),
						{
							topK: Math.min(3, this.plugin.settings.topK),
							threshold: this.plugin.settings.similarityThreshold,
							headerBoostWeight: this.plugin.settings.headerBoostWeight ?? 0.15,
							queryTitle: finalTitle,
							queryDescription: finalDesc,
							queryTags: mergedTags,
							strictAutoLink: true,
						}
				  )
				: [];

			// Decide destination folder based on OKF type
			const targetFolder = this.plugin.okf.getTargetFolderForType(finalType);
			if (!(await this.app.vault.adapter.exists(targetFolder))) {
				await this.app.vault.createFolder(targetFolder);
			}

			// Prepare YAML frontmatter & markdown content
			const nowIso = OKFManager.nowISOUTC();
			const safeFileName = toKebabSlug(finalTitle);

			let targetPath = normalizePath(`${targetFolder}/${safeFileName || "concept"}.md`);
			let counter = 1;
			while (await this.app.vault.adapter.exists(targetPath)) {
				targetPath = normalizePath(`${targetFolder}/${safeFileName}-${counter}.md`);
				counter++;
			}

			const relatedCalloutLines: string[] = [];
			if (verifiedRelated.length > 0) {
				relatedCalloutLines.push("", "## Related");
				for (const r of verifiedRelated) {
					const clean = r.path.replace(/^\/+/, "");
					const desc = r.description ? ` — ${r.description}` : "";
					relatedCalloutLines.push(`- [${r.title}](/${clean})${desc}`);
				}
			}

			const contentLines = [
				"---",
				`type: ${finalType}`,
				`title: "${finalTitle.replace(/"/g, '\\"')}"`,
				`description: "${finalDesc.replace(/"/g, '\\"')}"`,
				resourceUri ? `resource: "${resourceUri}"` : "",
				`tags: [${mergedTags.join(", ")}]`,
				`timestamp: ${nowIso}`,
				"---",
				"",
				`# ${finalTitle}`,
				"",
				resourceUri ? `> **Source:** [${resourceUri}](${resourceUri})` : "",
				"",
				synthesis.markdownBody,
				...relatedCalloutLines,
				"",
			].filter((l) => l !== "");

			// Step 8: Write file to vault
			const createdFile = await this.app.vault.create(targetPath, contentLines.join("\n"));

			// Step 9: Reciprocal Cross-Linking into Topic Hub (only if verified match)
			await this.integrateIntoTopicHub(
				createdFile,
				finalTitle,
				finalDesc,
				synthesis.suggestedTopic,
				verifiedRelated
			);

			// Step 10: Immediately Index Newly Created Note
			await this.plugin.indexer.indexFile(createdFile, true);

			progress.hide();
			new Notice(`Lattice: Created OKF note "${createdFile.path}".`);
			return createdFile;
		} catch (err) {
			progress.hide();
			console.error("Lattice Ingestion Failure:", err);
			new Notice(`Lattice: Ingestion failed for "${target}".`);
			return null;
		}
	}

	/**
	 * Ingests a directory of documents sequentially with live progress notices and duplicate skipping.
	 */
	public async ingestDirectory(
		dirPath: string,
		options: IngestOptions = {}
	): Promise<TFile[]> {
		const createdFiles: TFile[] = [];
		const filesToProcess = await this.collectFilesRecursively(dirPath);

		if (filesToProcess.length === 0) {
			new Notice(`Lattice: No supported documents found in "${dirPath}".`);
			return [];
		}

		const total = filesToProcess.length;
		new Notice(`Lattice: Found ${total} documents to process in "${dirPath}".`);

		for (let i = 0; i < total; i++) {
			const current = filesToProcess[i];
			const shortName = path.basename(current);
			const batchNotice = new Notice(`Lattice: [${i + 1}/${total}] Ingesting "${shortName}"...`, 0);

			try {
				const file = await this.ingestSingleDocument(current, options);
				if (file) {
					createdFiles.push(file);
				}
			} catch (err) {
				console.error(`Failed to ingest ${current}`, err);
			} finally {
				batchNotice.hide();
			}
		}

		new Notice(`Lattice: Completed directory ingestion. Created ${createdFiles.length} OKF concepts.`);
		return createdFiles;
	}

	/**
	 * Checks existing vault notes to see if a note already points to this resource.
	 */
	private findExistingNoteForResource(resourceUri: string, title: string): TFile | null {
		if (!resourceUri) return null;
		const files = this.app.vault.getMarkdownFiles();
		const slug = toKebabSlug(title);

		for (const file of files) {
			if (file.basename.toLowerCase() === slug) {
				return file;
			}
			const cache = this.app.metadataCache.getFileCache(file);
			const existingRes = cache?.frontmatter?.resource;
			if (typeof existingRes === "string" && existingRes.trim() === resourceUri.trim()) {
				return file;
			}
		}
		return null;
	}

	/**
	 * Integrates the newly created concept into the most relevant topic hub in `topics/`
	 * ONLY when a verified semantic match or explicit slug match exists.
	 */
	private async integrateIntoTopicHub(
		sourceFile: TFile,
		title: string,
		description: string,
		suggestedTopic?: string,
		verifiedRelated: Array<{ path: string; type: string }> = []
	): Promise<void> {
		const topicFolder = this.plugin.okf.getTargetFolderForType("topic") || "topics";
		const topicPrefix = topicFolder.replace(/\/+$/, "") + "/";
		if (sourceFile.path.startsWith(topicPrefix)) {
			return; // Do not link topic hubs into themselves
		}

		try {
			if (!(await this.app.vault.adapter.exists(topicFolder))) {
				return;
			}

			const topicFiles = this.app.vault
				.getMarkdownFiles()
				.filter((f) => f.path.startsWith(topicPrefix) && f.basename.toLowerCase() !== "overview");

			let targetTopic: TFile | null = null;

			// 1. Prefer a topic hub that already passed high-precision semantic matching
			const matchedTopicRecord = verifiedRelated.find(
				(r) => r.type.toLowerCase() === "topic" || r.path.startsWith(topicPrefix)
			);
			if (matchedTopicRecord) {
				const cleanPath = matchedTopicRecord.path.replace(/^\/+/, "");
				targetTopic = topicFiles.find((f) => f.path === cleanPath) || null;
			}

			// 2. Otherwise check if suggestedTopic matches an existing topic hub slug
			if (!targetTopic && suggestedTopic) {
				const slug = toKebabSlug(suggestedTopic);
				if (slug && slug.length >= 3) {
					targetTopic =
						topicFiles.find(
							(f) =>
								f.basename.toLowerCase() === slug ||
								f.basename.toLowerCase().includes(slug)
						) || null;
				}
			}

			if (targetTopic) {
				const content = await this.app.vault.read(targetTopic);
				const linkEntry = `- [${title}](/${sourceFile.path}) — ${description}`;

				if (!content.includes(sourceFile.path)) {
					let updatedContent = content;
					if (updatedContent.includes("## Sources")) {
						updatedContent = updatedContent.replace(
							"## Sources",
							`## Sources\n${linkEntry}`
						);
					} else {
						updatedContent += `\n\n## Sources\n${linkEntry}\n`;
					}
					await this.app.vault.modify(targetTopic, updatedContent);
				}
			}
		} catch (err) {
			console.warn("Lattice: Could not update topic hub with reciprocal link", err);
		}
	}

	/**
	 * Recursively scans a local directory for supported document files.
	 */
	private async collectFilesRecursively(dir: string): Promise<string[]> {
		const results: string[] = [];
		const supportedExts = new Set([".pptx", ".docx", ".pdf", ".txt", ".md"]);

		async function scan(currentDir: string) {
			const entries = await fs.readdir(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(currentDir, entry.name);
				if (entry.isDirectory()) {
					if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
						await scan(fullPath);
					}
				} else if (entry.isFile()) {
					const ext = path.extname(entry.name).toLowerCase();
					if (supportedExts.has(ext)) {
						results.push(fullPath);
					}
				}
			}
		}

		await scan(dir);
		return results;
	}
}
