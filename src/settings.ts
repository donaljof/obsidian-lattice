import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LatticePlugin from "./main";

export type OKFType = "note" | "paper" | "topic" | "project";
export type AIProvider = "ollama" | "cloud" | "auto";
export type CloudProvider = "gemini" | "anthropic" | "openai";
export type ChatScopeMode = "wiki-active" | "wiki-global" | "active-only";

export interface OKFFrontmatter {
	type?: OKFType | string;
	title?: string;
	description?: string;
	resource?: string;
	tags?: string[] | string;
	timestamp?: string;
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
	aiProvider: AIProvider;
	cloudProvider: CloudProvider;
	cloudApiKey: string;
	cloudModel: string;
	cloudBaseUrl: string;
	customCloudRoot: string;
	excludedFolders: string[];
	excludedFiles: string[];
	inboxFolder: string;
	typeFolderMap: Record<string, string>;
	topK: number;
	similarityThreshold: number;
	headerBoostWeight: number;
	defaultChatScope: ChatScopeMode;
	debounceMs: number;
	exportSharedVectors: boolean;
	sharedVectorsPath: string;
	autoIndexOnStartup: boolean;
}

export const DEFAULT_SETTINGS: LatticeSettings = {
	ollamaUrl: "http://localhost:11434",
	embeddingModel: "nomic-embed-text",
	chatModel: "qwen3:8b",
	aiProvider: "auto",
	cloudProvider: "gemini",
	cloudApiKey: "",
	cloudModel: "gemini-2.5-flash",
	cloudBaseUrl: "",
	customCloudRoot: "",
	excludedFolders: [
		".obsidian",
		".git",
		".okf",
		".claude",
		".agents",
		".opencode",
		".copilot",
		"copilot",
		"meta",
		".trash",
		"templates",
		"node_modules",
		"__pycache__",
	],
	excludedFiles: [
		"index.md",
		"log.md",
		"README.md",
		"CLAUDE.md",
		"AGENTS.md",
		"GEMINI.md",
		"VAULT.md",
		"tasks.md",
	],
	inboxFolder: "inbox",
	typeFolderMap: {
		note: "notes",
		paper: "sources/literature",
		topic: "topics",
		project: "projects",
	},
	topK: 5,
	similarityThreshold: 0.35,
	headerBoostWeight: 0.15,
	defaultChatScope: "wiki-active",
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

		const chatModelSetting = new Setting(containerEl)
			.setName("Chat / Metadata Model")
			.setDesc(
				"Ollama model used for conversational chat and OKF synthesis. Larger models (e.g. qwen3:8b, mistral:latest) provide substantially higher reasoning and synthesis quality than 3B models."
			);

		void this.plugin.indexer.fetchInstalledOllamaModels().then((models) => {
			const chatModels = models.filter((m) => !m.includes("embed"));
			if (chatModels.length > 0) {
				chatModelSetting.addDropdown((drop) => {
					for (const m of chatModels) {
						drop.addOption(m, m);
					}
					if (
						this.plugin.settings.chatModel &&
						!chatModels.includes(this.plugin.settings.chatModel)
					) {
						drop.addOption(
							this.plugin.settings.chatModel,
							this.plugin.settings.chatModel
						);
					}
					drop.setValue(this.plugin.settings.chatModel || chatModels[0]);
					drop.onChange(async (val) => {
						this.plugin.settings.chatModel = val;
						await this.plugin.savePluginData();
					});
				});
			} else {
				chatModelSetting.addText((text) =>
					text
						.setPlaceholder("qwen3:8b")
						.setValue(this.plugin.settings.chatModel)
						.onChange(async (value) => {
							this.plugin.settings.chatModel = value.trim() || "qwen3:8b";
							await this.plugin.savePluginData();
						})
				);
			}
		});

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
			.setDesc("Minimum centered similarity score (0.1 to 0.9) required to surface a related concept.")
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

		new Setting(containerEl)
			.setName("OKF Header & Tag Boost Weight")
			.setDesc(
				"Soft boost weight (0.00 to 0.40) for matching OKF tags, title, and description. Gated by semantic similarity so incorrect tags cannot force false matches (0 = off)."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.0, 0.4, 0.02)
					.setValue(this.plugin.settings.headerBoostWeight ?? 0.15)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.headerBoostWeight = value;
						await this.plugin.savePluginData();
						this.plugin.refreshSidebar();
					})
			);

		// --- Vault & OKF Configuration ---
		containerEl.createEl("h3", { text: "Chat & Knowledge Traversal" });

		new Setting(containerEl)
			.setName("Default Knowledge Traversal Scope")
			.setDesc(
				"Scope of vault notes consulted by the Chat Assistant. 'Active Note + Wiki Graph' traverses explicit links & hubs from the active note first."
			)
			.addDropdown((drop) =>
				drop
					.addOption(
						"wiki-active",
						"Active Note + Wiki Graph (Default & Recommended)"
					)
					.addOption(
						"wiki-global",
						"Global Wiki Graph (/topics/overview.md & Hubs)"
					)
					.addOption("active-only", "Active Note Only")
					.setValue(this.plugin.settings.defaultChatScope || "wiki-active")
					.onChange(async (val) => {
						this.plugin.settings.defaultChatScope = val as ChatScopeMode;
						await this.plugin.savePluginData();
					})
			);

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
		const typeFolderMap = this.plugin.okf.getTypeFolderMap();
		const mapPairs = Object.entries(typeFolderMap)
			.map(([t, f]) => `${t} → ${f}/`)
			.join(", ");

		const summaryLines = report
			? [
					`Notes Indexed: ${report.indexedNotes} / ${report.totalIndexableNotes} (${report.validOkfNotes} OKF-complete)`,
					`Vector Dimension: ${report.primaryVectorDimension ? `${report.primaryVectorDimension}D` : "None cached"}`,
					`Type Routing: ${mapPairs}`,
			  ].join(" • ")
			: `Type Routing: ${mapPairs}`;

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

		// --- Knowledge Loader & AI Synthesis Configuration ---
		containerEl.createEl("h3", { text: "Knowledge Loader & AI Synthesis" });

		new Setting(containerEl)
			.setName("AI Model Provider")
			.setDesc("Choose whether to synthesize notes via local Ollama, Cloud API, or Auto (Ollama first with Cloud fallback).")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", "Auto (Local Ollama with Cloud Fallback)")
					.addOption("ollama", "Local Ollama Only")
					.addOption("cloud", "Cloud API Only")
					.setValue(this.plugin.settings.aiProvider || "auto")
					.onChange(async (val) => {
						this.plugin.settings.aiProvider = val as AIProvider;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Cloud AI Provider")
			.setDesc("Select the cloud API provider to use for synthesis.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("gemini", "Google Gemini")
					.addOption("anthropic", "Anthropic Claude")
					.addOption("openai", "OpenAI / Compatible")
					.setValue(this.plugin.settings.cloudProvider || "gemini")
					.onChange(async (val) => {
						this.plugin.settings.cloudProvider = val as CloudProvider;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Cloud API Key")
			.setDesc("API key for Google Gemini, Anthropic, or OpenAI.")
			.addText((text) =>
				text
					.setPlaceholder("Enter API Key")
					.setValue(this.plugin.settings.cloudApiKey || "")
					.onChange(async (val) => {
						this.plugin.settings.cloudApiKey = val.trim();
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Cloud Model Name")
			.setDesc("e.g. gemini-2.5-flash, claude-3-5-sonnet-20241022, or gpt-4o-mini.")
			.addText((text) =>
				text
					.setPlaceholder("gemini-2.5-flash")
					.setValue(this.plugin.settings.cloudModel || "gemini-2.5-flash")
					.onChange(async (val) => {
						this.plugin.settings.cloudModel = val.trim();
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Google Drive / Cloud Root Path")
			.setDesc("Optional anchor folder (e.g. 'C:/Users/donal/My Drive'). Used to compute portable gdrive:// URIs across machines.")
			.addText((text) =>
				text
					.setPlaceholder("C:/Users/.../My Drive")
					.setValue(this.plugin.settings.customCloudRoot || "")
					.onChange(async (val) => {
						this.plugin.settings.customCloudRoot = val.trim();
						await this.plugin.savePluginData();
					})
			);
	}
}
