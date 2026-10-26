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
		const checkVaultBtn = headerActions.createEl("button", {
			cls: `lattice-btn ${
				this.showVaultConformancePanel ? "lattice-btn-primary" : ""
			}`,
			text: "Check Vault OKF",
		});
		checkVaultBtn.setAttr(
			"title",
			"Lightweight in-memory OKF conformance scan across all vault notes (<2ms)"
		);
		checkVaultBtn.addEventListener("click", () => {
			this.showVaultConformancePanel = !this.showVaultConformancePanel;
			if (this.showVaultConformancePanel) {
				this.plugin.okf.scanVaultOKFConformance(true);
			}
			void this.renderView();
		});

		const syncBtn = headerActions.createEl("button", {
			cls: "lattice-btn",
			text: "Sync",
		});
		syncBtn.setAttr("title", "Incremental vault vector sync");
		syncBtn.addEventListener("click", async () => {
			await this.plugin.indexer.scanVault(false);
		});

		if (this.showVaultConformancePanel) {
			this.renderVaultConformancePanel(container);
		}

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

		// 2. Active File OKF Status Bar & Post-Change Connected Conformance
		const connectedReport =
			this.plugin.okf.verifyNoteAndConnectedConformance(activeFile);
		const validation = connectedReport.noteValidation;
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

		const activeRight = activeBanner.createDiv({
			cls: "lattice-active-note-actions",
		});

		if (validation.isValid) {
			const validBadge = activeRight.createSpan({
				cls: "lattice-badge lattice-badge-valid",
				text: "OKF Valid",
			});
			validBadge.setAttr(
				"title",
				"All required OKF frontmatter headers are present and valid."
			);
		} else {
			const issues = [
				validation.missingFields.length > 0
					? `Missing: ${validation.missingFields.join(", ")}`
					: "",
				...validation.warnings,
			]
				.filter(Boolean)
				.join(" | ");
			const invalidBadge = activeRight.createSpan({
				cls: "lattice-badge lattice-badge-invalid",
				text: "Incomplete",
			});
			invalidBadge.setAttr("title", issues || "Incomplete OKF headers");
		}

		// Always keep "Enrich OKF" available both post new-note creation AND later in the lifecycle when content changes
		const enrichBtn = activeRight.createEl("button", {
			cls: validation.isValid
				? "lattice-btn"
				: "lattice-btn lattice-btn-primary",
			text: "Enrich OKF",
		});
		enrichBtn.setAttr(
			"title",
			validation.isValid
				? "Re-analyze note content to update OKF headers and verify connected notes"
				: `Generate OKF headers from note content (missing: ${validation.missingFields.join(", ")})`
		);
		enrichBtn.addEventListener("click", async () => {
			await this.plugin.okf.enrichNoteFrontmatter(activeFile, true);
		});

		// If the active note is in `inbox/`, offer 1-click `okf-refactor` filing to its canonical type folder
		if (this.plugin.okf.isNoteInInbox(activeFile)) {
			const targetFolder = this.plugin.okf.getTargetFolderForType(
				validation.frontmatter.type
			);
			const fileBtn = activeRight.createEl("button", {
				cls: "lattice-btn lattice-btn-primary",
				text: `File → ${targetFolder}/`,
			});
			fileBtn.setAttr(
				"title",
				`Move from inbox/ to /${targetFolder}/ with lowercase kebab-case slug and log to log.md`
			);
			fileBtn.addEventListener("click", async () => {
				if (!validation.isValid) {
					await this.plugin.okf.enrichNoteFrontmatter(activeFile, true);
				}
				await this.plugin.okf.fileNoteFromInbox(activeFile);
			});
		}

		// 2b. Connected Notes OKF Conformance & Asymmetric Hub Strip
		if (
			connectedReport.connectedNotes.length > 0 ||
			connectedReport.unresolvedLinks.length > 0
		) {
			const connBox = header.createDiv({ cls: "lattice-connected-conformance" });
			const connHeader = connBox.createDiv({
				cls: "lattice-connected-header",
			});

			const totalConn = connectedReport.connectedNotes.length;
			const validConn = connectedReport.validConnectedCount;
			const issueCount =
				connectedReport.invalidConnectedNotes.length +
				connectedReport.asymmetricHubNotes.length +
				connectedReport.unresolvedLinks.length;
			const allLinksValid = issueCount === 0;

			connHeader.createSpan({
				cls: "lattice-connected-label",
				text: `Connected Notes: ${validConn}/${totalConn} OKF Valid`,
			});

			connHeader.createSpan({
				cls: `lattice-badge ${
					allLinksValid ? "lattice-badge-valid" : "lattice-badge-invalid"
				}`,
				text: allLinksValid
					? "Links Conformant"
					: `${issueCount} Issue(s)`,
			});

			if (
				connectedReport.invalidConnectedNotes.length > 0 ||
				connectedReport.asymmetricHubNotes.length > 0
			) {
				const invalidList = connBox.createDiv({
					cls: "lattice-conformance-list",
				});

				for (const item of connectedReport.invalidConnectedNotes) {
					const row = invalidList.createDiv({
						cls: "lattice-conformance-row",
					});
					const left = row.createDiv({
						cls: "lattice-conformance-row-left",
					});
					const arrow =
						item.direction === "both"
							? "↔"
							: item.direction === "outgoing"
							? "→"
							: "←";
					left.createSpan({
						cls: "lattice-conformance-arrow",
						text: arrow,
					});
					const linkEl = left.createSpan({
						cls: "lattice-card-title",
						text: item.file.basename,
					});
					linkEl.setAttr("title", `Open ${item.file.path}`);
					linkEl.addEventListener("click", async () => {
						await this.app.workspace.getLeaf(false).openFile(item.file);
					});

					const missingText =
						item.validation.missingFields.length > 0
							? `missing: ${item.validation.missingFields.join(", ")}`
							: item.validation.warnings[0] || "non-standard";
					left.createSpan({
						cls: "lattice-conformance-missing",
						text: `(${missingText})`,
					});

					const fixBtn = row.createEl("button", {
						cls: "lattice-btn lattice-btn-primary",
						text: "Enrich",
					});
					fixBtn.setAttr(
						"title",
						`Enrich OKF headers for connected note "${item.file.basename}"`
					);
					fixBtn.addEventListener("click", async () => {
						await this.plugin.okf.enrichNoteFrontmatter(item.file, true);
						await this.renderView();
					});
				}

				for (const item of connectedReport.asymmetricHubNotes) {
					const row = invalidList.createDiv({
						cls: "lattice-conformance-row",
					});
					const left = row.createDiv({
						cls: "lattice-conformance-row-left",
					});
					left.createSpan({
						cls: "lattice-conformance-arrow",
						text: "→",
					});
					const linkEl = left.createSpan({
						cls: "lattice-card-title",
						text: item.file.basename,
					});
					linkEl.setAttr("title", `Open hub ${item.file.path}`);
					linkEl.addEventListener("click", async () => {
						await this.app.workspace.getLeaf(false).openFile(item.file);
					});
					left.createSpan({
						cls: "lattice-conformance-missing",
						text: "(hub does not link back)",
					});

					const backlinkBtn = row.createEl("button", {
						cls: "lattice-btn lattice-btn-primary",
						text: "+ Link Back",
					});
					backlinkBtn.setAttr(
						"title",
						`Add reciprocal link to "${activeFile.basename}" inside hub "${item.file.basename}"`
					);
					backlinkBtn.addEventListener("click", async () => {
						await this.plugin.okf.addReciprocalLink(
							activeFile,
							item.file
						);
						await this.renderView();
					});
				}
			}

			if (connectedReport.unresolvedLinks.length > 0) {
				const unresolvedEl = connBox.createDiv({
					cls: "lattice-conformance-unresolved",
					text: `Unwritten concept links: ${connectedReport.unresolvedLinks.join(", ")}`,
				});
				unresolvedEl.setAttr(
					"title",
					"Advisory: these outgoing links point to concepts not yet written."
				);
			}
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
				headerBoostWeight: this.plugin.settings.headerBoostWeight ?? 0.15,
				queryTitle: activeRecord.title,
				queryDescription: activeRecord.description,
				queryTags: activeRecord.tags,
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
		const normPath = neighbor.path.replace(/^\/+/, "");
		const mdPath = normPath.endsWith(".md") ? normPath : `${normPath}.md`;
		const cursorBtn = actions.createEl("button", {
			cls: "lattice-btn",
			text: "@ Cursor",
		});
		cursorBtn.setAttr(
			"title",
			`Insert [${neighbor.title}](/${mdPath}) at current editor cursor`
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
			await navigator.clipboard.writeText(`[${neighbor.title}](/${mdPath})`);
			new Notice(`Copied [${neighbor.title}](/${mdPath})`);
		});
	}

	/**
	 * Renders the ultra-lightweight full-vault OKF conformance & graph lint audit panel (<2ms in-memory check).
	 */
	private renderVaultConformancePanel(container: HTMLElement): void {
		const summary = this.plugin.okf.scanVaultOKFConformance(false);
		const panel = container.createDiv({ cls: "lattice-vault-audit-panel" });

		const headerRow = panel.createDiv({ cls: "lattice-connected-header" });
		headerRow.createSpan({
			cls: "lattice-connected-label",
			text: `Vault OKF Conformance: ${summary.validCount}/${summary.totalNotes} Valid (${summary.durationMs}ms)`,
		});

		const headerRight = headerRow.createDiv({
			cls: "lattice-active-note-actions",
		});
		headerRight.createSpan({
			cls: `lattice-badge ${
				summary.invalidCount === 0
					? "lattice-badge-valid"
					: "lattice-badge-invalid"
			}`,
			text:
				summary.invalidCount === 0
					? "PASS"
					: `${summary.invalidCount} Error(s)`,
		});

		const closeBtn = headerRight.createEl("button", {
			cls: "lattice-btn",
			text: "×",
		});
		closeBtn.setAttr("title", "Hide vault conformance report");
		closeBtn.addEventListener("click", () => {
			this.showVaultConformancePanel = false;
			void this.renderView();
		});

		// Advisory Graph Lint Summary (Inbox, Orphans, Asymmetric Hub Links)
		const metaStats = [
			summary.inboxNotes.length > 0
				? `Inbox staging: ${summary.inboxNotes.length}`
				: "",
			summary.asymmetricLinks.length > 0
				? `Asymmetric hub links: ${summary.asymmetricLinks.length}`
				: "",
			summary.orphanNotes.length > 0
				? `Orphans: ${summary.orphanNotes.length}`
				: "",
		].filter(Boolean);

		if (metaStats.length > 0) {
			panel.createDiv({
				cls: "lattice-conformance-missing",
				text: metaStats.join(" • "),
			});
		}

		if (
			summary.invalidCount === 0 &&
			summary.inboxNotes.length === 0 &&
			summary.asymmetricLinks.length === 0
		) {
			panel.createDiv({
				cls: "lattice-conformance-all-ok",
				text: "✓ Every concept in the vault conforms to OKF v0.1.",
			});
			return;
		}

		const listEl = panel.createDiv({ cls: "lattice-conformance-list" });
		const maxVisible = 25;

		// 1. Non-conformant concepts (ERRORS)
		for (const item of summary.invalidNotes.slice(0, maxVisible)) {
			const row = listEl.createDiv({ cls: "lattice-conformance-row" });
			const left = row.createDiv({ cls: "lattice-conformance-row-left" });

			const linkEl = left.createSpan({
				cls: "lattice-card-title",
				text: item.file.basename,
			});
			linkEl.setAttr("title", `Open ${item.file.path}`);
			linkEl.addEventListener("click", async () => {
				await this.app.workspace.getLeaf(false).openFile(item.file);
			});

			const missingText =
				item.validation.missingFields.length > 0
					? `missing: ${item.validation.missingFields.join(", ")}`
					: item.validation.warnings[0] || "non-standard";
			left.createSpan({
				cls: "lattice-conformance-missing",
				text: `(${missingText})`,
			});

			const enrichBtn = row.createEl("button", {
				cls: "lattice-btn lattice-btn-primary",
				text: "Enrich",
			});
			enrichBtn.setAttr(
				"title",
				`Enrich OKF frontmatter for "${item.file.basename}"`
			);
			enrichBtn.addEventListener("click", async () => {
				await this.plugin.okf.enrichNoteFrontmatter(item.file, true);
				await this.renderView();
			});
		}

		// 2. Un-normalized inbox/ notes (ADVISORY)
		for (const item of summary.inboxNotes.slice(0, 10)) {
			const row = listEl.createDiv({ cls: "lattice-conformance-row" });
			const left = row.createDiv({ cls: "lattice-conformance-row-left" });
			left.createSpan({
				cls: "lattice-conformance-arrow",
				text: "[inbox]",
			});
			const linkEl = left.createSpan({
				cls: "lattice-card-title",
				text: item.file.basename,
			});
			linkEl.setAttr("title", `Open ${item.file.path}`);
			linkEl.addEventListener("click", async () => {
				await this.app.workspace.getLeaf(false).openFile(item.file);
			});

			const enrichBtn = row.createEl("button", {
				cls: "lattice-btn",
				text: "Refactor",
			});
			enrichBtn.setAttr(
				"title",
				`Enrich OKF headers and file "${item.file.basename}" from inbox/`
			);
			enrichBtn.addEventListener("click", async () => {
				const ok = await this.plugin.okf.enrichNoteFrontmatter(
					item.file,
					true
				);
				if (ok) {
					await this.plugin.okf.fileNoteFromInbox(item.file);
				}
				await this.renderView();
			});
		}

		// 3. Asymmetric hub links (okf_lint.py ASYMMETRIC)
		for (const pair of summary.asymmetricLinks.slice(0, 10)) {
			const row = listEl.createDiv({ cls: "lattice-conformance-row" });
			const left = row.createDiv({ cls: "lattice-conformance-row-left" });
			const linkEl = left.createSpan({
				cls: "lattice-card-title",
				text: `${pair.sourceFile.basename} → ${pair.hubFile.basename}`,
			});
			linkEl.setAttr("title", `Hub "${pair.hubFile.path}" does not link back`);
			linkEl.addEventListener("click", async () => {
				await this.app.workspace.getLeaf(false).openFile(pair.hubFile);
			});

			const fixBtn = row.createEl("button", {
				cls: "lattice-btn",
				text: "+ Link Back",
			});
			fixBtn.addEventListener("click", async () => {
				await this.plugin.okf.addReciprocalLink(
					pair.sourceFile,
					pair.hubFile
				);
				await this.renderView();
			});
		}

		if (summary.invalidNotes.length > maxVisible) {
			panel.createDiv({
				cls: "lattice-conformance-missing",
				text: `+ ${summary.invalidNotes.length - maxVisible} more incomplete note(s)...`,
			});
		}
	}
}
