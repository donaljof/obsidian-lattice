import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type LatticePlugin from "./main";
import { findRelatedConcepts } from "./math";
import type { ScoredVectorRecord } from "./settings";

export const VIEW_TYPE_LATTICE = "lattice-related-concepts-view";

export class LatticeSidebarView extends ItemView {
	private plugin: LatticePlugin;
	private activeTypeFilter = "All";
	private lastActiveFile: TFile | null = null;
	private showVaultConformancePanel = false;

	constructor(leaf: WorkspaceLeaf, plugin: LatticePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	public openVaultConformancePanel(): void {
		this.showVaultConformancePanel = true;
		this.plugin.okf.scanVaultOKFConformance(true);
		void this.renderView();
	}

	getViewType(): string {
		return VIEW_TYPE_LATTICE;
	}

	getDisplayText(): string {
		return "Lattice — Related Concepts";
	}

	getIcon(): string {
		return "network";
	}

	async onOpen(): Promise<void> {
		await this.renderView();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private getBadgeClass(type: string): string {
		const lower = (type || "default").toLowerCase().trim();
		const sanitized = lower.replace(/[^a-z0-9_-]/g, "");
		return `lattice-badge lattice-badge-${sanitized || "default"}`;
	}

	public async renderView(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("lattice-view-container");

		// 1. Header & Status Indicator
		const header = container.createDiv({ cls: "lattice-header" });
		const headerTop = header.createDiv({ cls: "lattice-header-top" });

		const titleEl = headerTop.createEl("h4", { cls: "lattice-title" });
		const statusDot = titleEl.createSpan({ cls: "lattice-status-dot" });
		if (this.plugin.indexer.isIndexing) {
			statusDot.addClass("is-indexing");
			statusDot.setAttr("title", "Indexing vault vectors...");
		} else if (!this.plugin.indexer.isOllamaOnline) {
			statusDot.addClass("is-offline");
			statusDot.setAttr("title", "Ollama offline (serving cached vectors)");
		} else {
			statusDot.setAttr("title", "Ollama connected");
		}
		titleEl.createSpan({ text: "Lattice Discovery" });

		const headerActions = headerTop.createDiv({ cls: "lattice-filter-bar" });
		const syncBtn = headerActions.createEl("button", {
			cls: "lattice-btn",
			text: "Sync",
		});
		syncBtn.setAttr("title", "Incremental vault vector sync");
		syncBtn.addEventListener("click", async () => {
			await this.plugin.indexer.scanVault(false);
		});

		const currentFile = this.app.workspace.getActiveFile();
		if (currentFile && currentFile.extension.toLowerCase() === "md") {
			this.lastActiveFile = currentFile;
		}
		const activeFile =
			currentFile && currentFile.extension.toLowerCase() === "md"
				? currentFile
				: this.lastActiveFile &&
				  this.app.vault.getAbstractFileByPath(this.lastActiveFile.path) instanceof TFile
				? this.lastActiveFile
				: null;

		if (!activeFile) {
			const empty = container.createDiv({ cls: "lattice-empty-state" });
			empty.createEl("div", {
				text: "Open a markdown note to discover related OKF concepts.",
			});
			return;
		}

		// 2. Active File OKF Status Bar
		const validation = this.plugin.okf.validateFile(activeFile);
		const activeBanner = header.createDiv({ cls: "lattice-active-note" });
		const activeLeft = activeBanner.createDiv({
			cls: "lattice-card-title-group",
		});
		const fileType =
			typeof validation.frontmatter.type === "string"
				? validation.frontmatter.type
				: "Untyped";
		activeLeft.createSpan({
			cls: this.getBadgeClass(fileType),
			text: fileType,
		});
		activeLeft.createSpan({
			cls: "lattice-active-note-title",
			text: activeFile.basename,
		});

		if (validation.isValid) {
			activeBanner.createSpan({
				cls: "lattice-badge lattice-badge-valid",
				text: "OKF Valid",
			});
		} else {
			const enrichBtn = activeBanner.createEl("button", {
				cls: "lattice-btn lattice-btn-primary",
				text: "Enrich OKF",
			});
			enrichBtn.setAttr(
				"title",
				`Missing OKF fields: ${validation.missingFields.join(", ")}`
			);
			enrichBtn.addEventListener("click", async () => {
				await this.plugin.okf.enrichNoteFrontmatter(activeFile, false);
			});
		}

		// 3. OKF Type Filter Bar
		const filterBar = container.createDiv({ cls: "lattice-filter-bar" });
		const discoveredTypes = this.plugin.okf.getDiscoveredTypes();
		if (
			this.activeTypeFilter !== "All" &&
			!discoveredTypes.some(
				(t) => t.toLowerCase() === this.activeTypeFilter.toLowerCase()
			)
		) {
			this.activeTypeFilter = "All";
		}
		const filterOptions = ["All", ...discoveredTypes];
		for (const opt of filterOptions) {
			const pill = filterBar.createSpan({
				cls: `lattice-filter-pill ${
					this.activeTypeFilter === opt ? "is-active" : ""
				}`,
				text: opt,
			});
			pill.addEventListener("click", () => {
				this.activeTypeFilter = opt;
				void this.renderView();
			});
		}

		// 4. Retrieve Active Note Vector & Compute Top-K Neighbors
		let activeRecord = this.plugin.indexer.getRecord(activeFile.path);
		if (!activeRecord && this.plugin.indexer.shouldIndexFile(activeFile)) {
			// Attempt on-the-fly indexing if Ollama is online
			activeRecord =
				(await this.plugin.indexer.indexFile(activeFile, false)) || undefined;
		}

		if (!activeRecord || !activeRecord.vector || activeRecord.vector.length === 0) {
			const empty = container.createDiv({ cls: "lattice-empty-state" });
			empty.createDiv({
				text: this.plugin.indexer.isOllamaOnline
					? "This note has not been indexed yet."
					: "No cached vector for this note and Ollama is currently offline.",
			});
			const indexNowBtn = empty.createEl("button", {
				cls: "lattice-btn lattice-btn-primary",
				text: "Index Note Now",
			});
			indexNowBtn.addEventListener("click", async () => {
				const rec = await this.plugin.indexer.indexFile(activeFile, true);
				if (!rec) {
					new Notice(
						"Lattice: Could not generate embedding. Ensure Ollama is running with nomic-embed-text."
					);
				}
				await this.renderView();
			});
			return;
		}

		const neighbors = findRelatedConcepts(
			activeRecord.vector,
			this.plugin.indexer.getStore(),
			{
				excludePath: activeFile.path,
				filterType: this.activeTypeFilter,
				topK: this.plugin.settings.topK,
				threshold: this.plugin.settings.similarityThreshold,
			}
		);

		// 5. Render Related Concepts List
		const rawContent = await this.app.vault.cachedRead(activeFile);

		const sectionHeader = container.createDiv({
			cls: "lattice-section-title",
		});
		sectionHeader.createSpan({
			text: `Related Concepts (${neighbors.length})`,
		});

		if (neighbors.length > 0) {
			const calloutBtn = sectionHeader.createEl("button", {
				cls: "lattice-btn",
				text: "+ Link All",
			});
			calloutBtn.setAttr(
				"title",
				"Cross-link all unlinked related concepts into this note"
			);
			calloutBtn.addEventListener("click", async () => {
				await this.plugin.okf.appendRelatedCallout(activeFile, neighbors);
				await this.renderView();
			});
		}

		if (neighbors.length === 0) {
			const empty = container.createDiv({ cls: "lattice-empty-state" });
			empty.createDiv({
				text: "No related OKF concepts above similarity threshold.",
			});
		} else {
			const listEl = container.createDiv({ cls: "lattice-results-list" });
			for (const neighbor of neighbors) {
				const isLinked = this.plugin.okf.isConceptLinkedInContent(
					rawContent,
					neighbor
				);
				this.renderNeighborCard(listEl, activeFile, neighbor, isLinked);
			}
		}

		// 6. Disambiguate Unlinked Mentions
		if (neighbors.length > 0) {
			const mentions = this.plugin.okf.findUnlinkedMentions(
				rawContent,
				neighbors
			);

			if (mentions.length > 0) {
				const mentionTitle = container.createDiv({
					cls: "lattice-section-title",
				});
				mentionTitle.createSpan({
					text: `Unlinked Mentions (${mentions.length})`,
				});

				const mentionsList = container.createDiv({
					cls: "lattice-mentions-list",
				});
				for (const mention of mentions) {
					const item = mentionsList.createDiv({
						cls: "lattice-mention-item",
					});
					const textGroup = item.createDiv({
						cls: "lattice-mention-text",
					});
					textGroup.createSpan({
						cls: this.getBadgeClass(mention.record.type),
						text: mention.record.type,
					});
					textGroup.createSpan({
						text: `"${mention.matchedText}"`,
					});

					const linkBtn = item.createEl("button", {
						cls: "lattice-btn lattice-btn-primary",
						text: "Link [[ ]]",
					});
					linkBtn.addEventListener("click", async () => {
						await this.plugin.okf.convertMentionToWikiLink(
							activeFile,
							mention
						);
						await this.renderView();
					});
				}
			}
		}
	}

	private renderNeighborCard(
		parent: HTMLElement,
		activeFile: TFile,
		neighbor: ScoredVectorRecord,
		isLinked: boolean
	): void {
		const card = parent.createDiv({ cls: "lattice-card" });

		// Header: Badge + Title + Similarity %
		const cardHeader = card.createDiv({ cls: "lattice-card-header" });
		const titleGroup = cardHeader.createDiv({
			cls: "lattice-card-title-group",
		});

		titleGroup.createSpan({
			cls: this.getBadgeClass(neighbor.type),
			text: neighbor.type || "Seed",
		});

		const titleLink = titleGroup.createSpan({
			cls: "lattice-card-title",
			text: neighbor.title,
		});
		titleLink.setAttr("title", `Open ${neighbor.path}`);
		titleLink.addEventListener("click", async () => {
			const targetFile = this.app.vault.getAbstractFileByPath(neighbor.path);
			if (targetFile instanceof TFile) {
				await this.app.workspace.getLeaf(false).openFile(targetFile);
			}
		});

		const pct = Math.round(neighbor.similarity * 100);
		cardHeader.createSpan({
			cls: "lattice-score-pill",
			text: `${pct}%`,
		});

		// Description
		if (neighbor.description) {
			card.createDiv({
				cls: "lattice-card-description",
				text: neighbor.description,
			});
		}

		// Tags
		if (neighbor.tags && neighbor.tags.length > 0) {
			const tagsEl = card.createDiv({ cls: "lattice-card-tags" });
			for (const tag of neighbor.tags.slice(0, 4)) {
				tagsEl.createSpan({
					cls: "lattice-tag",
					text: `#${tag}`,
				});
			}
		}

		// Action buttons
		const actions = card.createDiv({ cls: "lattice-card-actions" });

		// 1-Click Cross-Link Button (works directly on the file without needing cursor focus)
		const crossLinkBtn = actions.createEl("button", {
			cls: isLinked
				? "lattice-btn lattice-btn-linked"
				: "lattice-btn lattice-btn-primary",
			text: isLinked ? "✓ Linked" : "+ Cross-Link",
		});
		crossLinkBtn.setAttr(
			"title",
			isLinked
				? `"${neighbor.title}" is already linked in "${activeFile.basename}"`
				: `1-click connect [[${neighbor.title}]] into "${activeFile.basename}"`
		);
		crossLinkBtn.addEventListener("click", async () => {
			if (isLinked) return;
			const ok = await this.plugin.okf.crossLinkConcept(
				activeFile,
				neighbor
			);
			if (ok) {
				await this.renderView();
			}
		});

		// Secondary: Insert at Cursor (preserves editor focus via mousedown preventDefault)
		const cursorBtn = actions.createEl("button", {
			cls: "lattice-btn",
			text: "@ Cursor",
		});
		cursorBtn.setAttr(
			"title",
			`Insert [[${neighbor.path.replace(/\.md$/i, "")}|${neighbor.title}]] at current editor cursor`
		);
		cursorBtn.addEventListener("mousedown", (e) => {
			// Prevent sidebar click from stealing focus from the Markdown editor cursor
			e.preventDefault();
		});
		cursorBtn.addEventListener("click", async () => {
			await this.plugin.okf.insertWikiLinkAtCursor(neighbor, activeFile);
			await this.renderView();
		});

		const copyBtn = actions.createEl("button", {
			cls: "lattice-btn",
			text: "Copy",
		});
		copyBtn.addEventListener("click", async () => {
			const cleanPath = neighbor.path.replace(/\.md$/i, "");
			await navigator.clipboard.writeText(`[[${cleanPath}|${neighbor.title}]]`);
			new Notice(`Copied [[${cleanPath}|${neighbor.title}]]`);
		});
	}
}
