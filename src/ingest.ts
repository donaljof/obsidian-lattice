import { Readability } from "@mozilla/readability";
import {
	App,
	Modal,
	Notice,
	TFile,
	normalizePath,
	requestUrl,
} from "obsidian";
import type LatticePlugin from "./main";
import { findRelatedConcepts } from "./math";
import { OKFManager } from "./okf";

export class UrlIngestModal extends Modal {
	private plugin: LatticePlugin;
	private urlInput = "";
	private selectedType = "Reference";
	private customTagsInput = "";

	constructor(app: App, plugin: LatticePlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Lattice — Clip URL to OKF Note" });
		contentEl.createEl("p", {
			text: "Fetches web page via requestUrl, strips DOM clutter with Readability, and synthesizes an atomic OKF note with semantic [[WikiLinks]].",
			cls: "setting-item-description",
		});

		const form = contentEl.createDiv({ cls: "lattice-modal-form" });

		// URL Row
		const urlRow = form.createDiv({ cls: "lattice-modal-row" });
		urlRow.createEl("label", { text: "Source URL" });
		const urlInputEl = urlRow.createEl("input", {
			type: "url",
			placeholder: "https://example.com/article",
		});
		urlInputEl.addEventListener("input", (e) => {
			this.urlInput = (e.target as HTMLInputElement).value.trim();
		});

		// Default OKF Type Row
		const typeRow = form.createDiv({ cls: "lattice-modal-row" });
		typeRow.createEl("label", { text: "Target OKF Type" });
		const typeSelect = typeRow.createEl("select");
		const discoveredTypes = this.plugin.okf.getDiscoveredTypes();
		if (
			discoveredTypes.length > 0 &&
			!discoveredTypes.some(
				(t) => t.toLowerCase() === this.selectedType.toLowerCase()
			)
		) {
			this.selectedType = discoveredTypes[0];
		}
		for (const t of discoveredTypes) {
			const opt = typeSelect.createEl("option", {
				text: t,
				value: t,
			});
			if (t.toLowerCase() === String(this.selectedType).toLowerCase()) opt.selected = true;
		}
		typeSelect.addEventListener("change", (e) => {
			this.selectedType = (e.target as HTMLSelectElement).value;
		});

		// Optional Tags Row
		const tagsRow = form.createDiv({ cls: "lattice-modal-row" });
		tagsRow.createEl("label", { text: "Additional Tags (optional, comma-separated)" });
		const tagsInputEl = tagsRow.createEl("input", {
			type: "text",
			placeholder: "knowledge-graphs, rag",
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
			text: "Ingest to OKF Note",
		});

		const triggerSubmit = async () => {
			if (!this.urlInput || !/^https?:\/\//i.test(this.urlInput)) {
				new Notice("Lattice: Please enter a valid http:// or https:// URL.");
				return;
			}
			submitBtn.disabled = true;
			submitBtn.setText("Ingesting...");
			try {
				const createdFile = await this.ingestUrl(
					this.urlInput,
					this.selectedType,
					this.customTagsInput
				);
				this.close();
				if (createdFile) {
					await this.app.workspace.getLeaf(false).openFile(createdFile);
				}
			} finally {
				submitBtn.disabled = false;
				submitBtn.setText("Ingest to OKF Note");
			}
		};

		submitBtn.addEventListener("click", triggerSubmit);
		urlInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void triggerSubmit();
			}
		});

		setTimeout(() => urlInputEl.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * Full Single-URL to OKF Note Pipeline:
	 * 1. Fetch HTML via Obsidian's CORS-free `requestUrl()`
	 * 2. Strip DOM clutter via `@mozilla/readability`
	 * 3. Embed extracted text to find top semantic neighbors in the vault (`findRelatedConcepts`)
	 * 4. Prompt local Ollama to structure content into an OKF note with `[[WikiLinks]]`
	 * 5. Write file to `00_Inbox/` and index
	 */
	public async ingestUrl(
		url: string,
		preferredType: string,
		extraTagsRaw: string
	): Promise<TFile | null> {
		const progressNotice = new Notice(
			`Lattice: Fetching ${url}...`,
			0
		);

		try {
			// Step 1: Fetch HTML via CORS-free requestUrl
			const response = await requestUrl({
				url,
				method: "GET",
				headers: {
					Accept: "text/html,application/xhtml+xml",
				},
				throw: false,
			});

			if (response.status < 200 || response.status >= 400 || !response.text) {
				progressNotice.hide();
				new Notice(
					`Lattice: Failed to fetch URL (HTTP ${response.status}).`
				);
				return null;
			}

			// Step 2: Strip DOM clutter via @mozilla/readability
			const parser = new DOMParser();
			const doc = parser.parseFromString(response.text, "text/html");
			const reader = new Readability(doc);
			const article = reader.parse();

			const rawTitle =
				article?.title?.trim() ||
				doc.title?.trim() ||
				new URL(url).hostname;
			const cleanText = (
				article?.textContent ||
				doc.body?.textContent ||
				""
			)
				.replace(/\s+\n/g, "\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim();

			if (!cleanText) {
				progressNotice.hide();
				new Notice("Lattice: Could not extract readable text from URL.");
				return null;
			}

			// Step 3: Find related OKF concepts from the vault vector store
			progressNotice.setMessage(
				"Lattice: Finding related vault concepts & structuring with Ollama..."
			);

			const snippetForEmbedding = `Title: ${rawTitle}\n\n${cleanText.slice(0, 3000)}`;
			const queryVector =
				await this.plugin.indexer.fetchEmbedding(snippetForEmbedding);

			const relatedRecords = queryVector
				? findRelatedConcepts(
						queryVector,
						this.plugin.indexer.getStore(),
						{
							topK: this.plugin.settings.topK,
							threshold: this.plugin.settings.similarityThreshold,
						}
					)
				: [];

			const availableWikiLinks = relatedRecords.map((r) => {
				const cleanPath = r.path.replace(/\.md$/i, "");
				return `[[${cleanPath}|${r.title}]] (${r.description || r.type})`;
			});

			// Step 4: Prompt Ollama to structure into an OKF note
			const structured = await this.synthesizeOKFNoteWithOllama(
				url,
				rawTitle,
				cleanText,
				preferredType,
				availableWikiLinks
			);

			const finalTitle = structured.title || rawTitle;
			const finalType = this.plugin.okf.normalizeType(
				structured.type || preferredType
			);
			const finalDesc =
				structured.description ||
				article?.excerpt?.slice(0, 150) ||
				`Clipped reference from ${new URL(url).hostname}.`;

			const userTags = extraTagsRaw
				.split(",")
				.map((t) =>
					t
						.trim()
						.toLowerCase()
						.replace(/[^a-z0-9-_]/g, "-")
				)
				.filter(Boolean);
			const mergedTags = Array.from(
				new Set([...structured.tags, ...userTags, "web-clip"])
			).slice(0, 6);

			const relatedCalloutLines: string[] = [];
			if (relatedRecords.length > 0) {
				relatedCalloutLines.push("", "> [!info] Related Concepts");
				for (const r of relatedRecords) {
					const cleanPath = r.path.replace(/\.md$/i, "");
					const pct = Math.round(r.similarity * 100);
					relatedCalloutLines.push(
						`> - **[${r.type}]** [[${cleanPath}|${r.title}]] (${pct}%)`
					);
				}
			}

			const today = OKFManager.todayISO();
			const yamlLines = [
				"---",
				`type: ${finalType}`,
				`title: "${finalTitle.replace(/"/g, '\\"')}"`,
				`description: "${finalDesc.replace(/"/g, '\\"')}"`,
				`tags: [${mergedTags.join(", ")}]`,
				`created: ${today}`,
				`status: seed`,
				`source: "${url}"`,
				"---",
				"",
				`# ${finalTitle}`,
				"",
				`> **Source:** [${url}](${url})`,
				"",
				structured.markdownBody,
				...relatedCalloutLines,
				"",
			];

			// Step 5: Write file to Inbox folder
			const inboxFolder = normalizePath(
				this.plugin.settings.inboxFolder || "00_Inbox"
			);
			if (!(await this.app.vault.adapter.exists(inboxFolder))) {
				await this.app.vault.createFolder(inboxFolder);
			}

			const safeFileName = finalTitle
				.replace(/[\\/:*?"<>|]/g, "-")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 80);

			let targetPath = normalizePath(
				`${inboxFolder}/${safeFileName || "Clipped Note"}.md`
			);
			let counter = 1;
			while (await this.app.vault.adapter.exists(targetPath)) {
				targetPath = normalizePath(
					`${inboxFolder}/${safeFileName} (${counter}).md`
				);
				counter++;
			}

			const file = await this.app.vault.create(
				targetPath,
				yamlLines.join("\n")
			);

			progressNotice.hide();
			new Notice(`Lattice: Created OKF note "${file.path}".`);

			// Index newly created note
			await this.plugin.indexer.indexFile(file, true);
			return file;
		} catch (err) {
			progressNotice.hide();
			console.error("Lattice: URL ingest failed", err);
			new Notice("Lattice: Failed to clip URL. See console for details.");
			return null;
		}
	}

	private async synthesizeOKFNoteWithOllama(
		url: string,
		rawTitle: string,
		cleanText: string,
		preferredType: string,
		availableWikiLinks: string[]
	): Promise<{
		type: string;
		title: string;
		description: string;
		tags: string[];
		markdownBody: string;
	}> {
		const fallbackBody = [
			"## Summary",
			"",
			cleanText.slice(0, 4000),
		].join("\n");

		try {
			const discoveredTypes = this.plugin.okf.getDiscoveredTypes();
			const wikiLinkContext =
				availableWikiLinks.length > 0
					? `Existing Vault Concepts (weave relevant [[WikiLinks]] naturally into the prose):\n${availableWikiLinks.join("\n")}`
					: "No existing vault concepts matched yet.";

			const prompt = [
				"You are an Open Knowledge Format (OKF) synthesizer for an Obsidian knowledge vault.",
				"Convert the following extracted web article into a structured atomic note.",
				"Return a strict JSON object with these keys:",
				`- "type": "${preferredType}" (or one of ${discoveredTypes.join(", ")})`,
				'- "title": Clean, concise concept title',
				'- "description": Single-sentence high-signal summary (max 160 chars)',
				'- "tags": Array of 2 to 5 lowercase kebab-case domain tags',
				'- "markdownBody": Well-structured Markdown body (using ## headings, bullet points, key takeaways, and weaving in any relevant [[WikiLinks]] provided below).',
				"",
				wikiLinkContext,
				"",
				`Source URL: ${url}`,
				`Extracted Title: ${rawTitle}`,
				"Article Content:",
				cleanText.slice(0, 6000),
			].join("\n");

			const res = await requestUrl({
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

			if (res.status === 200 && res.json?.response) {
				const parsed = JSON.parse(res.json.response);
				const tags = Array.isArray(parsed.tags)
					? parsed.tags
							.map((t: unknown) =>
								String(t)
									.toLowerCase()
									.replace(/[^a-z0-9-_]/g, "-")
							)
							.filter(Boolean)
					: [];

				return {
					type: typeof parsed.type === "string" ? parsed.type : preferredType,
					title: typeof parsed.title === "string" ? parsed.title : rawTitle,
					description:
						typeof parsed.description === "string" ? parsed.description : "",
					tags,
					markdownBody:
						typeof parsed.markdownBody === "string" &&
						parsed.markdownBody.trim()
							? parsed.markdownBody.trim()
							: fallbackBody,
				};
			}
		} catch {
			// If Ollama is offline or fails, fall back gracefully to Readability extraction
		}

		return {
			type: preferredType,
			title: rawTitle,
			description: `Extracted article from ${new URL(url).hostname}.`,
			tags: ["reference"],
			markdownBody: fallbackBody,
		};
	}
}
