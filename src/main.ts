import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { VectorIndexer } from "./indexer";
import { LatticeIngestModal, UrlIngestModal } from "./ingest";
import { findRelatedConcepts } from "./math";
import { OKFManager } from "./okf";
import {
	DEFAULT_SETTINGS,
	LatticeSettingTab,
	type LatticeSettings,
	type PersistedPluginData,
	type VectorRecord,
} from "./settings";
import { LatticeSidebarView, VIEW_TYPE_LATTICE } from "./view";

export default class LatticePlugin extends Plugin {
	public settings: LatticeSettings = { ...DEFAULT_SETTINGS };
	public indexer!: VectorIndexer;
	public okf!: OKFManager;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		const initialVectors = await this.loadPluginData();

		this.indexer = new VectorIndexer(this.app, this, initialVectors);
		this.okf = new OKFManager(this.app, this);

		// Register the Ambient Related Concepts Sidebar View
		this.registerView(
			VIEW_TYPE_LATTICE,
			(leaf: WorkspaceLeaf) => new LatticeSidebarView(leaf, this)
		);

		// Ribbon Icon to open Lattice Connect
		this.addRibbonIcon("network", "Lattice: Open Connect", () => {
			void this.activateSidebarView();
		});

		// Status Bar Indicator
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("mod-clickable");
		this.statusBarEl.addEventListener("click", () => {
			void this.activateSidebarView();
		});
		this.updateStatusBar();

		// Settings Tab
		this.addSettingTab(new LatticeSettingTab(this.app, this));

		// Register Command Palette Actions
		this.registerLatticeCommands();

		// Wait until workspace layout is ready before running lightweight startup discovery, attaching watchers, and scanning
		this.app.workspace.onLayoutReady(async () => {
			await this.okf.runStartupDiscovery(false);
			this.registerVaultAndWorkspaceEvents();
			this.updateStatusBar();
			this.refreshSidebar();

			if (this.settings.autoIndexOnStartup) {
				await this.indexer.scanVault(false);
				await this.okf.runStartupDiscovery(false);
			} else {
				await this.indexer.checkOllamaStatus(false);
			}
			this.refreshSidebar();
		});
	}

	onunload(): void {
		if (this.indexer) {
			this.indexer.destroy();
		}
	}

	private registerLatticeCommands(): void {
		// 1. Enrich / Update OKF Frontmatter on Active Note
		this.addCommand({
			id: "enrich-okf-frontmatter",
			name: "Enrich OKF Frontmatter (Add or Update Headers & Verify Connected Notes)",
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension.toLowerCase() === "md") {
					if (!checking) {
						void this.okf.enrichNoteFrontmatter(activeFile, true);
					}
					return true;
				}
				return false;
			},
		});

		// 2. Scan All Notes & Check OKF Conformance (Lightweight <2ms in-memory check)
		this.addCommand({
			id: "check-vault-okf-conformance",
			name: "Scan All Notes & Check OKF Conformance",
			callback: async () => {
				await this.activateSidebarView(true);
			},
		});

		// 3. Insert Related OKF Concepts Callout
		this.addCommand({
			id: "insert-related-okf-concepts",
			name: "Insert Related OKF Concepts",
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && activeFile.extension.toLowerCase() === "md") {
					if (!checking) {
						void this.insertRelatedCalloutForFile(activeFile);
					}
					return true;
				}
				return false;
			},
		});

		// Ingest Source or Topic (File, Folder, URL)
		this.addCommand({
			id: "ingest-source-or-topic",
			name: "Ingest Source or Topic (File, Folder, URL)",
			callback: () => {
				new LatticeIngestModal(this.app, this).open();
			},
		});

		// 3. Single URL to OKF Note Modal
		this.addCommand({
			id: "clip-url-to-okf-note",
			name: "Clip Single URL to OKF Note",
			callback: () => {
				new UrlIngestModal(this.app, this).open();
			},
		});

		// 4. Open Lattice Connect Sidebar
		this.addCommand({
			id: "open-related-concepts-sidebar",
			name: "Open Lattice Connect Sidebar",
			callback: () => {
				void this.activateSidebarView();
			},
		});

		// 4b. Open Lattice Chat Sidebar
		this.addCommand({
			id: "open-vault-chat",
			name: "Open Lattice Chat Sidebar",
			callback: () => {
				void this.activateSidebarView(false, true);
			},
		});

		// 5. Batch Enrich Inbox Folder
		this.addCommand({
			id: "batch-enrich-inbox",
			name: "Batch Enrich OKF Frontmatter in Inbox Folder",
			callback: () => {
				void this.okf.enrichInboxFolder();
			},
		});

		// 6. Sync / Reload Vectors after External CLI Run (Claude Code / Python)
		this.addCommand({
			id: "sync-cli-vectors",
			name: "Sync Vector Cache with External CLI (.okf/vectors.json)",
			callback: async () => {
				const count = await this.indexer.syncFromExternalCliCache();
				new Notice(
					`Lattice: Synced external CLI cache (${count} record(s) merged, ${this.indexer.getVectorCount()} total).`
				);
			},
		});

		// 7. Update Vault index.md Catalog
		this.addCommand({
			id: "update-okf-index-file",
			name: "Update Vault OKF index.md Catalog",
			callback: () => {
				void this.okf.updateVaultIndexFile();
			},
		});

		// 8. Run Vault Discovery & Consistency Check
		this.addCommand({
			id: "run-vault-discovery",
			name: "Run Vault Discovery & Consistency Check",
			callback: async () => {
				await this.okf.runStartupDiscovery(true);
				this.updateStatusBar();
				this.refreshSidebar();
			},
		});
	}

	private registerVaultAndWorkspaceEvents(): void {
		// Vault event hooks with 2000ms debounce in VectorIndexer
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.indexer.queueFileIndex(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.indexer.queueFileIndex(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.indexer.handleFileDelete(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.indexer.handleFileRename(file, oldPath);
			})
		);

		// Post-header-change hook: invalidate discovery cache, verify OKF conformance of the note + connected notes, and refresh sidebar
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.okf.invalidateDiscoveryCache();
				const report = this.okf.verifyNoteAndConnectedConformance(file);
				const active = this.app.workspace.getActiveFile();
				if (
					active &&
					(active.path === file.path ||
						report.connectedNotes.some(
							(c) => c.file.path === active.path
						))
				) {
					this.refreshSidebar();
				}
			})
		);

		// Ambient sidebar updates on active-leaf-change
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.refreshSidebar();
			})
		);
	}

	private async insertRelatedCalloutForFile(file: TFile): Promise<void> {
		let record = this.indexer.getRecord(file.path);
		if (!record) {
			record = (await this.indexer.indexFile(file, false)) || undefined;
		}
		if (!record || !record.vector || record.vector.length === 0) {
			new Notice(
				"Lattice: Note has no vector embedding yet. Ensure Ollama is running."
			);
			return;
		}

		const neighbors = findRelatedConcepts(
			record.vector,
			this.indexer.getStore(),
			{
				excludePath: file.path,
				topK: Math.min(3, this.settings.topK),
				threshold: this.settings.similarityThreshold,
				headerBoostWeight: this.settings.headerBoostWeight ?? 0.15,
				queryTitle: record.title,
				queryDescription: record.description,
				queryTags: record.tags,
				strictAutoLink: true,
			}
		);

		await this.okf.appendRelatedCallout(file, neighbors);
	}

	public async activateSidebarView(
		openVaultAudit = false,
		openChat = false
	): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_LATTICE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: VIEW_TYPE_LATTICE,
					active: true,
				});
			}
		}

		if (leaf) {
			await workspace.revealLeaf(leaf);
			if (leaf.view instanceof LatticeSidebarView) {
				if (openChat) {
					leaf.view.openChatPanel();
				} else if (openVaultAudit) {
					leaf.view.openVaultConformancePanel();
				}
			}
		}
	}

	public refreshSidebar(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LATTICE);
		for (const leaf of leaves) {
			if (leaf.view instanceof LatticeSidebarView) {
				void leaf.view.renderView();
			}
		}
	}

	public updateStatusBar(): void {
		if (!this.statusBarEl || !this.indexer) return;
		const count = this.indexer.getVectorCount();
		if (this.indexer.isIndexing) {
			this.statusBarEl.setText(`Lattice: Indexing (${count})...`);
		} else if (!this.indexer.isOllamaOnline) {
			this.statusBarEl.setText(`Lattice: ${count} vectors (Offline)`);
		} else {
			this.statusBarEl.setText(`Lattice: ${count} OKF vectors`);
		}
	}

	public async loadPluginData(): Promise<Record<string, VectorRecord>> {
		const raw = (await this.loadData()) as Partial<PersistedPluginData> | null;
		if (raw && typeof raw === "object") {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
			// Upgrade legacy small default "llama3.2" to modern recommended model "qwen3:8b"
			if (this.settings.chatModel === "llama3.2") {
				this.settings.chatModel = DEFAULT_SETTINGS.chatModel;
			}
			if (raw.vectors && typeof raw.vectors === "object") {
				return raw.vectors;
			}
		} else {
			this.settings = { ...DEFAULT_SETTINGS };
		}
		return {};
	}

	public async savePluginData(): Promise<void> {
		const payload: PersistedPluginData = {
			settings: this.settings,
			vectors: this.indexer ? this.indexer.getStore() : {},
		};
		await this.saveData(payload);
	}
}
