import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LatticePlugin from "./main";

export type OKFType = "Concept" | "Spec" | "Playbook" | "Reference" | "Seed";
export type OKFStatus = "seed" | "growing" | "evergreen";

export interface OKFFrontmatter {
	type?: OKFType | string;
	title?: string;
	description?: string;
	tags?: string[] | string;
	created?: string;
	status?: OKFStatus | string;
	[key: string]: unknown;
}

export interface VectorRecord {
	path: string;          // Relative vault path (OKF ID)
	title: string;         // Basename or YAML title
	mtime: number;         // Last modified timestamp
	type: string;          // OKF 'type' field for pre-filtering
	description: string;   // OKF 'description' for UI tooltips
	tags: string[];        // YAML tags
	vector: number[];      // Normalized embedding from nomic-embed-text
}

export interface ScoredVectorRecord extends VectorRecord {
	similarity: number;
}

export interface LatticeSettings {
	ollamaUrl: string;
	embeddingModel: string;
	chatModel: string;
	excludedFolders: string[];
	excludedFiles: string[];
	inboxFolder: string;
	topK: number;
	similarityThreshold: number;
	debounceMs: number;
	exportSharedVectors: boolean;
	sharedVectorsPath: string;
	autoIndexOnStartup: boolean;
}

export const DEFAULT_SETTINGS: LatticeSettings = {
	ollamaUrl: "http://localhost:11434",
	embeddingModel: "nomic-embed-text",
	chatModel: "llama3.2",
	excludedFolders: [".obsidian", ".git", ".okf", "templates", "node_modules"],
	excludedFiles: ["index.md", "log.md", "CLAUDE.md"],
	inboxFolder: "00_Inbox",
	topK: 7,
	similarityThreshold: 0.35,
	debounceMs: 2000,
	exportSharedVectors: true,
	sharedVectorsPath: ".okf/vectors.json",
	autoIndexOnStartup: true,
};

export interface PersistedPluginData {
	settings: Partial<LatticeSettings>;
	vectors: Record<string, VectorRecord>;
}

export class LatticeSettingTab extends PluginSettingTab {
	plugin: LatticePlugin;

	constructor(app: App, plugin: LatticePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Lattice — OKF & Vector Engine Settings" });

		// --- Ollama Engine Configuration ---
		containerEl.createEl("h3", { text: "Local LLM Engine (Ollama)" });

		new Setting(containerEl)
			.setName("Ollama Endpoint URL")
			.setDesc("Base URL of your local Ollama server (requires OLLAMA_ORIGINS=\"*\").")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:11434")
					.setValue(this.plugin.settings.ollamaUrl)
					.onChange(async (value) => {
						this.plugin.settings.ollamaUrl = value.trim().replace(/\/+$/, "");
						await this.plugin.savePluginData();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Test Connection").onClick(async () => {
					btn.setDisabled(true);
					btn.setButtonText("Testing...");
					const ok = await this.plugin.indexer.checkOllamaStatus(true);
					btn.setDisabled(false);
					btn.setButtonText("Test Connection");
					if (ok) {
						new Notice("Lattice: Connected to Ollama successfully!");
					} else {
						new Notice("Lattice: Cannot reach Ollama at " + this.plugin.settings.ollamaUrl);
					}
				})
			);

		new Setting(containerEl)
			.setName("Embedding Model")
			.setDesc("Ollama model used to generate normalized vector embeddings (e.g., nomic-embed-text).")
			.addText((text) =>
				text
					.setPlaceholder("nomic-embed-text")
					.setValue(this.plugin.settings.embeddingModel)
					.onChange(async (value) => {
						this.plugin.settings.embeddingModel = value.trim() || "nomic-embed-text";
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Chat / Metadata Model")
			.setDesc("Ollama model used for OKF frontmatter generation and single-URL ingestion (e.g., llama3.2, qwen2.5).")
			.addText((text) =>
				text
					.setPlaceholder("llama3.2")
					.setValue(this.plugin.settings.chatModel)
					.onChange(async (value) => {
						this.plugin.settings.chatModel = value.trim() || "llama3.2";
						await this.plugin.savePluginData();
					})
			);

		// --- Discovery & Retrieval ---
		containerEl.createEl("h3", { text: "Semantic Discovery & Retrieval" });

		new Setting(containerEl)
			.setName("Top-K Related Concepts")
			.setDesc("Maximum number of conceptually related OKF notes shown in the sidebar and callouts.")
			.addSlider((slider) =>
				slider
					.setLimits(3, 20, 1)
					.setValue(this.plugin.settings.topK)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.topK = value;
						await this.plugin.savePluginData();
						this.plugin.refreshSidebar();
					})
			);

		new Setting(containerEl)
			.setName("Minimum Similarity Threshold")
			.setDesc("Minimum cosine similarity score (0.0 to 1.0) required to surface a related concept.")
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 0.9, 0.05)
					.setValue(this.plugin.settings.similarityThreshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.similarityThreshold = value;
						await this.plugin.savePluginData();
						this.plugin.refreshSidebar();
					})
			);

		// --- Vault & OKF Configuration ---
		containerEl.createEl("h3", { text: "OKF Vault Boundaries & CLI Sync" });

		new Setting(containerEl)
			.setName("Inbox Folder")
			.setDesc("Target directory for clipped URLs and raw notes awaiting OKF enrichment.")
			.addText((text) =>
				text
					.setPlaceholder("00_Inbox")
					.setValue(this.plugin.settings.inboxFolder)
					.onChange(async (value) => {
						this.plugin.settings.inboxFolder = value.trim().replace(/^\/+|\/+$/g, "") || "00_Inbox";
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Excluded Navigation Files")
			.setDesc("Comma-separated filenames ignored during concept indexing (OKF navigation files).")
			.addText((text) =>
				text
					.setPlaceholder("index.md, log.md")
					.setValue(this.plugin.settings.excludedFiles.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludedFiles = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Excluded Folders")
			.setDesc("Comma-separated folder paths ignored during concept indexing.")
			.addText((text) =>
				text
					.setPlaceholder(".obsidian, .git, templates")
					.setValue(this.plugin.settings.excludedFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Export Shared CLI Cache (.okf/vectors.json)")
			.setDesc("Write a standalone JSON vector file so external CLI agents (Claude Code, Aider, Python) can query semantic similarity directly.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.exportSharedVectors)
					.onChange(async (value) => {
						this.plugin.settings.exportSharedVectors = value;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Shared CLI Cache Path")
			.setDesc("Vault-relative path for the exported CLI vector store.")
			.addText((text) =>
				text
					.setPlaceholder(".okf/vectors.json")
					.setValue(this.plugin.settings.sharedVectorsPath)
					.onChange(async (value) => {
						this.plugin.settings.sharedVectorsPath = value.trim() || ".okf/vectors.json";
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Vector Index Management")
			.setDesc(`Currently indexing ${this.plugin.indexer.getVectorCount()} OKF concepts in memory.`)
			.addButton((btn) =>
				btn
					.setButtonText("Incremental Sync")
					.onClick(async () => {
						await this.plugin.indexer.scanVault(false);
						await this.plugin.okf.runStartupDiscovery(false);
						this.display();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Rebuild Full Index")
					.setWarning()
					.onClick(async () => {
						await this.plugin.indexer.scanVault(true);
						await this.plugin.okf.runStartupDiscovery(false);
						this.display();
					})
			);

		// --- Startup Discovery & Vault Consistency ---
		containerEl.createEl("h3", { text: "Vault Discovery & Consistency" });

		const report = this.plugin.okf.getLastDiscoveryReport();
		const discoveredTypes = this.plugin.okf.getDiscoveredTypes();
		const discoveredStatuses = this.plugin.okf.getDiscoveredStatuses();

		const summaryLines = report
			? [
					`Notes Indexed: ${report.indexedNotes} / ${report.totalIndexableNotes} (${report.validOkfNotes} OKF-complete)`,
					`Vector Dimension: ${report.primaryVectorDimension ? `${report.primaryVectorDimension}D` : "None cached"}`,
					`Discovered Types: ${discoveredTypes.join(", ")}`,
					`Discovered Statuses: ${discoveredStatuses.join(", ")}`,
			  ].join(" • ")
			: `Discovered Types: ${discoveredTypes.join(", ")}`;

		new Setting(containerEl)
			.setName("Discovered Vault Schema & Health")
			.setDesc(summaryLines)
			.addButton((btn) =>
				btn
					.setButtonText("Run Discovery Check")
					.onClick(async () => {
						await this.plugin.okf.runStartupDiscovery(true);
						this.display();
					})
			);
	}
}
