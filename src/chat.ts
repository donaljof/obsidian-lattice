import {
	App,
	Modal,
	Notice,
	TFile,
	normalizePath,
} from "obsidian";
import { VectorIndexer } from "./indexer";
import {
	chatWithVaultLLM,
	type ProposedNoteChange,
	type ProposedNotePatch,
	type VaultChatResponse,
} from "./llm";
import type LatticePlugin from "./main";
import { extractHeaderTokens, findRelatedConcepts } from "./math";
import { OKFManager } from "./okf";

export type TraversalProvenance =
	| "anchor"
	| "topic-hub"
	| "graph-1hop"
	| "graph-2hop"
	| "unlinked-bridge";

export type ChatScopeMode = "wiki-active" | "wiki-global" | "active-only";

export interface TraversedWikiNode {
	path: string;
	title: string;
	type: string;
	description: string;
	tags: string[];
	provenance: TraversalProvenance;
	viaPath?: string;
	contentSnippet?: string;
	wasReadInFull?: boolean;
}

export interface HeaderGraphMapResult {
	nodes: TraversedWikiNode[];
	primaryTopicHubPath?: string;
	headerMapMarkdown: string;
	activeNoteSnippet?: string;
}

export interface ChatStepPill {
	icon: "map" | "read" | "edit" | "synthesize";
	label: string;
	targetPath?: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
	thoughtSteps?: string[];
	stepPills?: ChatStepPill[];
	traversedNodes?: TraversedWikiNode[];
	primaryTopicHubPath?: string;
	proposedChanges?: ProposedNoteChange[];
}

export interface DiffLine {
	type: "same" | "add" | "remove";
	text: string;
	oldLine?: number;
	newLine?: number;
}

/**
 * Computes a clean line-by-line Myers diff between `originalText` and `proposedText`
 * for the pop-up approval modal with linear memory footprint.
 */
export function computeLineDiff(
	originalText: string,
	proposedText: string
): DiffLine[] {
	const oldLines = originalText ? originalText.replace(/\r\n/g, "\n").split("\n") : [];
	const newLines = proposedText ? proposedText.replace(/\r\n/g, "\n").split("\n") : [];

	if (oldLines.length === 0) {
		return newLines.map((text, idx) => ({
			type: "add",
			text,
			newLine: idx + 1,
		}));
	}

	const m = oldLines.length;
	const n = newLines.length;

	// 1. Fast prefix trimming
	let start = 0;
	while (start < m && start < n && oldLines[start] === newLines[start]) {
		start++;
	}

	// 2. Fast suffix trimming
	let endOld = m - 1;
	let endNew = n - 1;
	while (
		endOld >= start &&
		endNew >= start &&
		oldLines[endOld] === newLines[endNew]
	) {
		endOld--;
		endNew--;
	}

	const prefixDiff: DiffLine[] = [];
	for (let i = 0; i < start; i++) {
		prefixDiff.push({
			type: "same",
			text: oldLines[i],
			oldLine: i + 1,
			newLine: i + 1,
		});
	}

	const midOld = oldLines.slice(start, endOld + 1);
	const midNew = newLines.slice(start, endNew + 1);
	const midM = midOld.length;
	const midN = midNew.length;

	const midDiff: DiffLine[] = [];
	const maxD = midM + midN;

	if (maxD === 0) {
		// Middle is identical
	} else if (maxD > 4000) {
		// Graceful fallback for exceptionally huge diffs (>4000 mid lines)
		for (let i = 0; i < midM; i++) {
			midDiff.push({ type: "remove", text: midOld[i], oldLine: start + i + 1 });
		}
		for (let j = 0; j < midN; j++) {
			midDiff.push({ type: "add", text: midNew[j], newLine: start + j + 1 });
		}
	} else {
		// Myers O((N+M)D) linear-space shortest edit script
		const vOffset = maxD;
		const v = new Int32Array(2 * maxD + 1);
		v[vOffset + 1] = 0;
		const trace: Int32Array[] = [];

		let reachedEnd = false;
		for (let d = 0; d <= maxD; d++) {
			trace.push(new Int32Array(v));
			for (let k = -d; k <= d; k += 2) {
				let x: number;
				if (k === -d || (k !== d && v[vOffset + k - 1] < v[vOffset + k + 1])) {
					x = v[vOffset + k + 1];
				} else {
					x = v[vOffset + k - 1] + 1;
				}
				let y = x - k;
				while (x < midM && y < midN && midOld[x] === midNew[y]) {
					x++;
					y++;
				}
				v[vOffset + k] = x;
				if (x >= midM && y >= midN) {
					reachedEnd = true;
					break;
				}
			}
			if (reachedEnd) break;
		}

		// Backtrack through trace to build exact edit path
		let x = midM;
		let y = midN;
		const editPath: Array<{ type: "same" | "add" | "remove"; oldIdx: number; newIdx: number }> = [];

		for (let d = trace.length - 1; d > 0; d--) {
			const k = x - y;
			const prevV = trace[d];
			let prevK: number;
			if (k === -d || (k !== d && prevV[vOffset + k - 1] < prevV[vOffset + k + 1])) {
				prevK = k + 1;
			} else {
				prevK = k - 1;
			}
			const prevX = prevV[vOffset + prevK];
			const prevY = prevX - prevK;

			while (x > prevX && y > prevY) {
				x--;
				y--;
				editPath.push({ type: "same", oldIdx: x, newIdx: y });
			}
			if (d > 0) {
				if (x === prevX) {
					y--;
					editPath.push({ type: "add", oldIdx: x, newIdx: y });
				} else {
					x--;
					editPath.push({ type: "remove", oldIdx: x, newIdx: y });
				}
			}
		}
		while (x > 0 && y > 0) {
			x--;
			y--;
			editPath.push({ type: "same", oldIdx: x, newIdx: y });
		}
		editPath.reverse();

		for (const step of editPath) {
			if (step.type === "same") {
				midDiff.push({
					type: "same",
					text: midOld[step.oldIdx],
					oldLine: start + step.oldIdx + 1,
					newLine: start + step.newIdx + 1,
				});
			} else if (step.type === "remove") {
				midDiff.push({
					type: "remove",
					text: midOld[step.oldIdx],
					oldLine: start + step.oldIdx + 1,
				});
			} else {
				midDiff.push({
					type: "add",
					text: midNew[step.newIdx],
					newLine: start + step.newIdx + 1,
				});
			}
		}
	}

	const suffixDiff: DiffLine[] = [];
	const tailLen = m - 1 - endOld;
	for (let k = 0; k < tailLen; k++) {
		suffixDiff.push({
			type: "same",
			text: oldLines[endOld + 1 + k],
			oldLine: endOld + 2 + k,
			newLine: endNew + 2 + k,
		});
	}

	return [...prefixDiff, ...midDiff, ...suffixDiff];
}

/**
 * Extracts explicit bundle-relative links `[Label](/path.md)` and `[[WikiLinks]]` from markdown text.
 */
export function extractExplicitLinksFromMarkdown(rawContent: string): string[] {
	const results = new Set<string>();

	const mdLinkRegex = /\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g;
	let match: RegExpExecArray | null;
	while ((match = mdLinkRegex.exec(rawContent)) !== null) {
		const target = decodeURIComponent(match[1].trim());
		if (/^(https?:|mailto:|gdrive:|onedrive:|file:)/i.test(target)) continue;
		const clean = target.replace(/^\/+/, "");
		if (clean) {
			results.add(clean.endsWith(".md") ? clean : `${clean}.md`);
		}
	}

	const wikiRegex = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
	while ((match = wikiRegex.exec(rawContent)) !== null) {
		const target = match[1].trim().replace(/^\/+/, "");
		if (target) {
			results.add(target.endsWith(".md") ? target : `${target}.md`);
		}
	}

	return Array.from(results);
}

/**
 * OKF / LLM-Wiki Graph-Traversal-First Engine (`AGENTS.md`):
 * Stage 1: Anchor resolution (Active Note, explicit mentions, `/topics/overview.md`, Topic Hub headers)
 * Stage 2: Explicit 1-Hop & 2-Hop Wiki Graph Traversal (outgoing links, backlinks, parent Topic Hubs)
 * Stage 3: Option 3 Vector Fallback strictly for unlinked bridges when explicit links are absent or sparse.
 */
export class VaultWikiTraverser {
	private app: App;
	private plugin: LatticePlugin;

	constructor(app: App, plugin: LatticePlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	public async traverseHeaderGraph(
		userPrompt: string,
		activeFile: TFile | null,
		scope: ChatScopeMode = "wiki-active"
	): Promise<HeaderGraphMapResult> {
		const visited = new Map<string, TraversedWikiNode>();
		const allFiles = this.app.vault?.getMarkdownFiles?.() || [];
		const fileByPath = new Map<string, TFile>();
		const fileByBasename = new Map<string, TFile>();

		for (const f of allFiles) {
			if (this.plugin.indexer && !this.plugin.indexer.shouldIndexFile(f)) {
				continue;
			}
			const norm = f.path.replace(/^\/+/, "");
			fileByPath.set(norm.toLowerCase(), f);
			fileByBasename.set(f.basename.toLowerCase(), f);
		}

		const queryTokens = extractHeaderTokens(userPrompt, "");
		const resolvedLinks: Record<string, Record<string, number>> =
			(this.app.metadataCache as unknown as {
				resolvedLinks?: Record<string, Record<string, number>>;
			})?.resolvedLinks || {};

		const resolveFile = (ref: string): TFile | null => {
			const clean = ref.replace(/^\/+/, "").toLowerCase();
			const withMd = clean.endsWith(".md") ? clean : `${clean}.md`;
			if (fileByPath.has(withMd)) return fileByPath.get(withMd)!;
			const base = clean.replace(/^.*\//, "").replace(/\.md$/i, "");
			return fileByBasename.get(base) || null;
		};

		const readNodeMeta = (file: TFile) => {
			const rec = this.plugin.indexer?.getRecord?.(file.path);
			const cache = this.app.metadataCache?.getFileCache?.(file);
			const fm = cache?.frontmatter || {};
			return {
				title:
					rec?.title ||
					(typeof fm.title === "string" && fm.title.trim()
						? fm.title.trim()
						: file.basename),
				type:
					rec?.type ||
					(typeof fm.type === "string" && fm.type.trim()
						? fm.type.trim()
						: "note"),
				description:
					rec?.description ||
					(typeof fm.description === "string" ? fm.description.trim() : ""),
				tags: rec?.tags || VectorIndexer.normalizeTags(fm.tags),
			};
		};

		const scoreHeaderMatch = (file: TFile): number => {
			if (queryTokens.size === 0) return 0;
			const meta = readNodeMeta(file);
			const nodeTokens = extractHeaderTokens(
				`${meta.title} ${file.basename}`,
				`${meta.description} ${meta.tags.join(" ")}`
			);
			let hits = 0;
			for (const qt of queryTokens) {
				if (nodeTokens.has(qt)) {
					hits += 1;
				} else {
					for (const nt of nodeTokens) {
						if (nt.includes(qt) || qt.includes(nt)) {
							hits += 0.5;
							break;
						}
					}
				}
			}
			return hits / Math.sqrt(queryTokens.size);
		};

		const addHeaderNode = async (
			file: TFile,
			provenance: TraversalProvenance,
			viaPath?: string,
			snippet?: string
		): Promise<void> => {
			const norm = file.path.replace(/^\/+/, "");
			if (visited.has(norm)) return;
			const meta = readNodeMeta(file);
			visited.set(norm, {
				path: norm,
				title: meta.title,
				type: meta.type,
				description: meta.description,
				tags: meta.tags,
				provenance,
				viaPath,
				contentSnippet: snippet,
				wasReadInFull: false,
			});
		};

		let activeSnippet = "";
		if (activeFile && scope !== "wiki-global") {
			const rawActive = await this.readFileSafe(activeFile);
			const activeBody = VectorIndexer.stripFrontmatter(rawActive);
			activeSnippet =
				activeBody.length > 700 ? `${activeBody.slice(0, 700)}...` : activeBody;
			await addHeaderNode(activeFile, "anchor", undefined, activeSnippet);
		}

		if (scope === "active-only") {
			return this.formatHeaderResult(visited, activeSnippet);
		}

		const promptRefs = extractExplicitLinksFromMarkdown(userPrompt);
		for (const ref of promptRefs) {
			const target = resolveFile(ref);
			if (target) {
				await addHeaderNode(target, "anchor", "prompt-mention");
			}
		}

		const topicHubFiles: Array<{ file: TFile; score: number }> = [];
		for (const f of allFiles) {
			const meta = readNodeMeta(f);
			const isTopicHub =
				meta.type.toLowerCase() === "topic" ||
				meta.type.toLowerCase() === "project" ||
				f.path.startsWith("topics/");
			if (isTopicHub && f.basename.toLowerCase() !== "overview") {
				const score = scoreHeaderMatch(f);
				if (score > 0) {
					topicHubFiles.push({ file: f, score });
				}
			}
		}
		topicHubFiles.sort((a, b) => b.score - a.score);

		for (const item of topicHubFiles.slice(0, 2)) {
			await addHeaderNode(item.file, "topic-hub", "header-match");
		}

		const getConnectedFiles = async (file: TFile): Promise<TFile[]> => {
			const connected = new Set<TFile>();
			const outgoing = resolvedLinks[file.path] || {};
			for (const outPath of Object.keys(outgoing)) {
				const target = resolveFile(outPath);
				if (target) connected.add(target);
			}

			for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
				if (links && links[file.path]) {
					const source = resolveFile(sourcePath);
					if (source) connected.add(source);
				}
			}

			const raw = await this.readFileSafe(file);
			const explicitRefs = extractExplicitLinksFromMarkdown(raw);
			for (const ref of explicitRefs) {
				const target = resolveFile(ref);
				if (target) connected.add(target);
			}

			return Array.from(connected);
		};

		const anchorFiles = Array.from(visited.values())
			.filter((n) => n.provenance === "anchor")
			.map((n) => resolveFile(n.path))
			.filter((f): f is TFile => f !== null);

		for (const anchor of anchorFiles) {
			const hop1Files = await getConnectedFiles(anchor);
			const hop1Hubs: TFile[] = [];
			const hop1Concepts: Array<{ file: TFile; score: number }> = [];

			for (const cand of hop1Files) {
				const meta = readNodeMeta(cand);
				const isHub =
					cand.path.startsWith("topics/") ||
					cand.path.startsWith("projects/") ||
					meta.type.toLowerCase() === "topic" ||
					meta.type.toLowerCase() === "project";
				if (isHub && cand.basename.toLowerCase() !== "overview") {
					hop1Hubs.push(cand);
				} else if (cand.basename.toLowerCase() !== "overview") {
					hop1Concepts.push({
						file: cand,
						score: scoreHeaderMatch(cand) + 0.1,
					});
				}
			}

			for (const hub of hop1Hubs.slice(0, 2)) {
				await addHeaderNode(hub, "topic-hub", anchor.path);
			}

			hop1Concepts.sort((a, b) => b.score - a.score);
			for (const item of hop1Concepts.slice(0, 3)) {
				await addHeaderNode(item.file, "graph-1hop", anchor.path);
			}
		}

		const discoveredHubNodes = Array.from(visited.values()).filter(
			(n) => n.provenance === "topic-hub" || n.provenance === "graph-1hop"
		);

		for (const hubNode of discoveredHubNodes) {
			const hubFile = resolveFile(hubNode.path);
			if (!hubFile) continue;
			const hop2Files = await getConnectedFiles(hubFile);
			const rankedHop2 = hop2Files
				.filter(
					(f) =>
						!visited.has(f.path.replace(/^\/+/, "")) &&
						f.basename.toLowerCase() !== "overview"
				)
				.map((f) => ({ file: f, score: scoreHeaderMatch(f) }))
				.filter((x) => x.score > 0 || visited.size < 4)
				.sort((a, b) => b.score - a.score);

			for (const item of rankedHop2.slice(0, 3)) {
				await addHeaderNode(item.file, "graph-2hop", hubNode.path);
				if (visited.size >= 7) break;
			}
		}

		if (visited.size === 0) {
			const overviewFile = resolveFile("topics/overview.md");
			if (overviewFile) {
				await addHeaderNode(overviewFile, "topic-hub", "moc-root");
			}
		}

		const explicitGraphCount = Array.from(visited.values()).filter(
			(n) => n.provenance !== "anchor"
		).length;

		const maxVectorBridges = explicitGraphCount < 2 ? 3 : 1;
		const store = this.plugin.indexer?.getStore?.() || {};

		if (Object.keys(store).length > 0 && maxVectorBridges > 0) {
			let queryVec: number[] | null = null;
			if (this.plugin.indexer?.fetchEmbedding) {
				queryVec = await this.plugin.indexer.fetchEmbedding(userPrompt);
			}
			if (!queryVec && activeFile) {
				queryVec = this.plugin.indexer.getRecord(activeFile.path)?.vector || null;
			}

			if (queryVec && queryVec.length > 0) {
				const activeRec = activeFile
					? this.plugin.indexer.getRecord(activeFile.path)
					: undefined;
				const vecMatches = findRelatedConcepts(queryVec, store, {
					excludePath: activeFile?.path,
					topK: 6,
					threshold: this.plugin.settings.similarityThreshold,
					headerBoostWeight: this.plugin.settings.headerBoostWeight ?? 0.15,
					queryTitle: userPrompt,
					queryDescription: activeRec?.description,
					queryTags: activeRec?.tags,
					strictAutoLink: explicitGraphCount >= 2,
				});

				let addedBridges = 0;
				for (const match of vecMatches) {
					const norm = match.path.replace(/^\/+/, "");
					if (visited.has(norm)) continue;
					const tf = resolveFile(norm);
					if (!tf) continue;
					await addHeaderNode(tf, "unlinked-bridge", "vector-fallback");
					addedBridges++;
					if (addedBridges >= maxVectorBridges) break;
				}
			}
		}

		return this.formatHeaderResult(visited, activeSnippet);
	}

	public async readSelectedNotes(
		paths: string[],
		existingNodes?: TraversedWikiNode[]
	): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		const cleanPaths = (paths || []).slice(0, 2);

		for (const p of cleanPaths) {
			const clean = p.replace(/^\/+/, "");
			const tf = this.resolveTFile(clean);
			if (tf) {
				const raw = await this.readFileSafe(tf);
				const body = VectorIndexer.stripFrontmatter(raw).trim();
				out[clean] = body;
				if (existingNodes) {
					const node = existingNodes.find(
						(n) => n.path.toLowerCase() === clean.toLowerCase()
					);
					if (node) {
						node.wasReadInFull = true;
						node.contentSnippet =
							body.length > 2500 ? `${body.slice(0, 2500)}...` : body;
					}
				}
			}
		}

		return out;
	}

	private resolveTFile(ref: string): TFile | null {
		const clean = ref.replace(/^\/+/, "");
		const withMd = clean.endsWith(".md") ? clean : `${clean}.md`;
		const direct = this.app.vault.getAbstractFileByPath(withMd);
		if (direct instanceof TFile) return direct;
		const all = this.app.vault.getMarkdownFiles?.() || [];
		return (
			all.find(
				(f) =>
					f.path.toLowerCase() === withMd.toLowerCase() ||
					f.basename.toLowerCase() === clean.replace(/\.md$/i, "").toLowerCase()
			) || null
		);
	}

	private formatHeaderResult(
		visited: Map<string, TraversedWikiNode>,
		activeNoteSnippet?: string
	): HeaderGraphMapResult {
		const nodes = Array.from(visited.values());
		const hubNode = nodes.find(
			(n) =>
				n.provenance === "topic-hub" &&
				n.path.toLowerCase() !== "topics/overview.md"
		);

		const lines: string[] = [
			"=== OKF GRAPH HEADER CHEATSHEET (Connected Knowledge Nodes) ===",
		];

		for (const node of nodes) {
			const prov =
				node.provenance === "anchor"
					? "ANCHOR"
					: node.provenance === "topic-hub"
					? "TOPIC HUB"
					: node.provenance === "graph-1hop"
					? `1-HOP (via /${node.viaPath})`
					: node.provenance === "graph-2hop"
					? `2-HOP (via /${node.viaPath})`
					: "BRIDGE (Unlinked Vector)";

			lines.push(
				`- [${prov}] /${node.path} | Title: "${node.title}" | Type: ${node.type} | Tags: [${node.tags.join(", ")}]${
					node.description ? ` | Desc: "${node.description}"` : ""
				}`
			);
		}

		return {
			nodes,
			primaryTopicHubPath: hubNode?.path,
			headerMapMarkdown: lines.join("\n"),
			activeNoteSnippet,
		};
	}



	private async readFileSafe(file: TFile): Promise<string> {
		try {
			if (this.app.vault.cachedRead) {
				return await this.app.vault.cachedRead(file);
			}
			return await this.app.vault.read(file);
		} catch {
			return "";
		}
	}
}

/**
 * Helper to turn any read-only assistant synthesis into an OKF-compliant `ProposedNoteChange`
 * so the user can review and accept it in `NoteChangeApprovalModal` (`AGENTS.md`: "File valuable answers back").
 */
export function buildSynthesisNoteProposal(
	replyMarkdown: string,
	userPrompt: string,
	traversedNodes: TraversedWikiNode[],
	primaryTopicHubPath?: string
): ProposedNoteChange {
	const rawHeading = replyMarkdown.match(/^#+\s+(.+)$/m)?.[1]?.trim();
	const cleanPromptTitle = userPrompt
		.replace(/[?!.]+$/g, "")
		.trim()
		.slice(0, 65);
	const title = rawHeading || cleanPromptTitle || "Vault Synthesis Note";
	const slug = OKFManager.toKebabSlug(title) || "vault-synthesis";
	const targetPath = `notes/${slug}.md`;

	// Collect top domain tags from traversed nodes
	const tagCounts = new Map<string, number>();
	for (const n of traversedNodes) {
		for (const t of n.tags) {
			const clean = t.toLowerCase().trim();
			if (clean && clean !== "inbox" && clean !== "moc" && clean !== "overview") {
				tagCounts.set(clean, (tagCounts.get(clean) || 0) + 1);
			}
		}
	}
	const tags = Array.from(tagCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4)
		.map(([t]) => t);
	if (tags.length === 0) tags.push("synthesis");

	const firstSentence =
		replyMarkdown
			.replace(/^#+\s+.+$/gm, "")
			.trim()
			.split(/(?<=[.!?])\s+/)[0]
			?.replace(/["\r\n]/g, "")
			.slice(0, 155) || `Synthesis generated from ${traversedNodes.length} vault concepts.`;

	const citationLines = traversedNodes.slice(0, 5).map((n) => {
		const desc = n.description ? ` — ${n.description}` : "";
		return `- [${n.title}](/${n.path})${desc}`;
	});

	const nowIso = OKFManager.nowISOUTC();
	const hasHeading = /^#\s+/m.test(replyMarkdown);
	const proposedContent = [
		"---",
		"type: note",
		`title: "${title.replace(/"/g, '\\"')}"`,
		`description: "${firstSentence.replace(/"/g, '\\"')}"`,
		`tags: [${tags.join(", ")}]`,
		`timestamp: ${nowIso}`,
		"---",
		"",
		hasHeading ? replyMarkdown.trim() : `# ${title}\n\n${replyMarkdown.trim()}`,
		...(citationLines.length > 0 && !replyMarkdown.includes("## Related")
			? ["", "## Related", ...citationLines]
			: []),
		"",
	].join("\n");

	return {
		action: "create",
		targetPath,
		title,
		summary: `File synthesis as new OKF note in /${targetPath}`,
		proposedContent,
		suggestedHubPath: primaryTopicHubPath,
	};
}

/**
 * Applies a low-token patch (append section or replace block) to an existing note's content,
 * reconstructing the full proposed document for line-by-line diff review.
 */
export function applyProposedPatchToContent(
	originalContent: string,
	patch?: ProposedNotePatch,
	fallbackContent?: string
): string {
	if (!patch) {
		return fallbackContent || originalContent;
	}

	if (patch.mode === "full") {
		return patch.fullContent || fallbackContent || originalContent;
	}

	if (patch.mode === "append" && patch.replaceBlock) {
		const blockToAppend = patch.replaceBlock.trim();
		if (!blockToAppend) return originalContent;

		const relatedMatch = originalContent.match(/^##\s+Related/m);
		if (relatedMatch && relatedMatch.index !== undefined) {
			const before = originalContent.slice(0, relatedMatch.index).trimEnd();
			const after = originalContent.slice(relatedMatch.index);
			return `${before}\n\n${blockToAppend}\n\n${after}`;
		}
		return `${originalContent.trimEnd()}\n\n${blockToAppend}\n`;
	}

	if (patch.mode === "replace" && patch.searchBlock && patch.replaceBlock) {
		const normalizedOriginal = originalContent.replace(/\r\n/g, "\n");
		const normalizedSearch = patch.searchBlock.replace(/\r\n/g, "\n").trim();
		if (normalizedOriginal.includes(normalizedSearch)) {
			return normalizedOriginal.replace(
				normalizedSearch,
				patch.replaceBlock.replace(/\r\n/g, "\n").trim()
			);
		}
	}

	return fallbackContent || originalContent;
}

/**
 * Pop-up Modal (`NoteChangeApprovalModal`) requiring explicit user permission
 * before creating or modifying any note in the vault.
 */
export class NoteChangeApprovalModal extends Modal {
	private plugin: LatticePlugin;
	private proposal: ProposedNoteChange;
	private onApplied?: (file: TFile) => void;
	private activeTab: "diff" | "edit" = "diff";
	private editablePath: string;
	private editableContent: string;
	private linkToHubCheckbox = true;

	constructor(
		app: App,
		plugin: LatticePlugin,
		proposal: ProposedNoteChange,
		onApplied?: (file: TFile) => void
	) {
		super(app);
		this.plugin = plugin;
		this.proposal = proposal;
		this.onApplied = onApplied;
		this.editablePath = proposal.targetPath.replace(/^\/+/, "");
		this.editableContent = proposal.proposedContent;
	}

	async onOpen(): Promise<void> {
		this.modalEl?.addClass?.("lattice-diff-modal-window");
		await this.renderModal();
	}

	private async renderModal(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("lattice-diff-modal");

		const cleanPath = normalizePath(this.editablePath);
		const existingFile = this.app.vault.getAbstractFileByPath(cleanPath);
		const isModify = existingFile instanceof TFile;
		const originalContent = isModify
			? await this.app.vault.read(existingFile)
			: "";

		// 1. Header with Action Badge & Summary
		const header = contentEl.createDiv({ cls: "lattice-diff-header" });
		const titleRow = header.createDiv({ cls: "lattice-diff-title-row" });

		titleRow.createSpan({
			cls: `lattice-badge ${
				isModify ? "lattice-badge-invalid" : "lattice-badge-valid"
			}`,
			text: isModify ? "MODIFY EXISTING NOTE" : "CREATE NEW NOTE",
		});
		titleRow.createEl("h3", {
			text: this.proposal.title || cleanPath,
			cls: "lattice-diff-heading",
		});

		header.createEl("p", {
			text: this.proposal.summary,
			cls: "setting-item-description",
		});

		// 2. Target Path & OKF Frontmatter Validation Row
		const pathRow = contentEl.createDiv({ cls: "lattice-modal-row" });
		pathRow.createEl("label", { text: "Target Vault Path" });
		const pathInput = pathRow.createEl("input", {
			type: "text",
			value: this.editablePath,
		});
		pathInput.addEventListener("input", (e) => {
			this.editablePath = (e.target as HTMLInputElement).value.trim();
		});

		// Optional Reciprocal Topic Hub Link Checkbox
		if (this.proposal.suggestedHubPath) {
			const hubRow = contentEl.createDiv({ cls: "lattice-diff-hub-row" });
			const label = hubRow.createEl("label");
			const cb = label.createEl("input", { type: "checkbox" });
			cb.checked = this.linkToHubCheckbox;
			label.appendChild(
				document.createTextNode(
					` Wire reciprocal link into Topic Hub (/${this.proposal.suggestedHubPath})`
				)
			);
			cb.addEventListener("change", (e) => {
				this.linkToHubCheckbox = (e.target as HTMLInputElement).checked;
			});
		}

		// 3. View Switcher Tabs: [ Visual Diff | Edit Markdown ]
		const tabBar = contentEl.createDiv({ cls: "lattice-mode-tabs" });
		const diffTabBtn = tabBar.createEl("button", {
			cls: `lattice-mode-tab ${this.activeTab === "diff" ? "is-active" : ""}`,
			text: isModify ? "Visual Line Diff" : "Formatted Diff Preview",
		});
		const editTabBtn = tabBar.createEl("button", {
			cls: `lattice-mode-tab ${this.activeTab === "edit" ? "is-active" : ""}`,
			text: "Edit Full Markdown",
		});

		diffTabBtn.addEventListener("click", () => {
			this.activeTab = "diff";
			void this.renderModal();
		});
		editTabBtn.addEventListener("click", () => {
			this.activeTab = "edit";
			void this.renderModal();
		});

		// 4. Body Container (Diff View vs Editable Textarea)
		const bodyContainer = contentEl.createDiv({ cls: "lattice-diff-body" });

		if (this.activeTab === "diff") {
			const diffLines = computeLineDiff(originalContent, this.editableContent);
			const addedCount = diffLines.filter((d) => d.type === "add").length;
			const removedCount = diffLines.filter((d) => d.type === "remove").length;

			const statsBar = bodyContainer.createDiv({ cls: "lattice-diff-stats" });
			statsBar.createSpan({
				cls: "lattice-diff-stat-add",
				text: `+${addedCount} added`,
			});
			statsBar.createSpan({
				cls: "lattice-diff-stat-remove",
				text: `-${removedCount} removed`,
			});

			const diffPre = bodyContainer.createDiv({ cls: "lattice-diff-lines" });
			for (const line of diffLines) {
				const row = diffPre.createDiv({
					cls: `lattice-diff-line lattice-diff-${line.type}`,
				});
				const prefix =
					line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
				row.createSpan({
					cls: "lattice-diff-prefix",
					text: prefix,
				});
				row.createSpan({
					cls: "lattice-diff-text",
					text: line.text || " ",
				});
			}
		} else {
			const textarea = bodyContainer.createEl("textarea", {
				cls: "lattice-diff-textarea",
			});
			textarea.value = this.editableContent;
			textarea.rows = 18;
			textarea.addEventListener("input", (e) => {
				this.editableContent = (e.target as HTMLTextAreaElement).value;
			});
		}

		// 5. Explicit Permission Footer Buttons
		const footer = contentEl.createDiv({ cls: "lattice-modal-footer" });
		const rejectBtn = footer.createEl("button", { text: "Reject / Cancel" });
		rejectBtn.addEventListener("click", () => this.close());

		const acceptBtn = footer.createEl("button", {
			cls: "mod-cta",
			text: isModify ? "Accept & Apply Edit" : "Accept & Create Note",
		});

		acceptBtn.addEventListener("click", async () => {
			acceptBtn.disabled = true;
			acceptBtn.setText("Applying...");
			try {
				const targetNorm = normalizePath(
					this.editablePath.replace(/^\/+/, "").endsWith(".md")
						? this.editablePath.replace(/^\/+/, "")
						: `${this.editablePath.replace(/^\/+/, "")}.md`
				);

				const folderParts = targetNorm.split("/");
				if (folderParts.length > 1) {
					const folderPath = folderParts.slice(0, -1).join("/");
					if (
						this.app.vault.adapter?.exists &&
						!(await this.app.vault.adapter.exists(folderPath))
					) {
						await this.app.vault.createFolder(folderPath);
					}
				}

				let savedFile: TFile;
				const currentAbstract = this.app.vault.getAbstractFileByPath(targetNorm);
				if (currentAbstract instanceof TFile) {
					await this.app.vault.modify(currentAbstract, this.editableContent);
					savedFile = currentAbstract;
				} else {
					savedFile = await this.app.vault.create(
						targetNorm,
						this.editableContent
					);
				}

				// Wire reciprocal link into parent Topic Hub if checked
				if (this.linkToHubCheckbox && this.proposal.suggestedHubPath) {
					const hubFile = this.app.vault.getAbstractFileByPath(
						this.proposal.suggestedHubPath.replace(/^\/+/, "")
					);
					if (hubFile instanceof TFile && hubFile.path !== savedFile.path) {
						await this.plugin.okf.addReciprocalLink(savedFile, hubFile);
					}
				}

				// Index immediately & log
				await this.plugin.indexer.indexFile(savedFile, true);
				await this.plugin.okf.appendLogEntry(
					isModify ? "edit" : "create",
					`${savedFile.basename}: ${this.proposal.summary}`
				);

				this.proposal.applied = true;
				new Notice(
					`Lattice: ${isModify ? "Updated" : "Created"} "/${savedFile.path}".`
				);
				this.close();
				if (this.onApplied) {
					this.onApplied(savedFile);
				}
			} catch (err) {
				console.error("Lattice: Failed to apply note change", err);
				new Notice(`Lattice: Failed to save note — ${String(err)}`);
			} finally {
				acceptBtn.disabled = false;
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
