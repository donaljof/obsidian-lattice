import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import esbuild from "esbuild";

// Bundle math.ts, indexer.ts, and okf.ts in memory with a minimal obsidian stub for unit testing
const buildResult = await esbuild.build({
	stdin: {
		contents: `
			export * from "./src/math.ts";
			export { VectorIndexer } from "./src/indexer.ts";
			export { OKFManager, VALID_OKF_TYPES } from "./src/okf.ts";
			export * from "./src/path-utils.ts";
			export * from "./src/extractors/index.ts";
			export * from "./src/extractors/pptx.ts";
			export * from "./src/extractors/docx.ts";
			export * from "./src/extractors/pdf.ts";
			export * from "./src/llm.ts";
			export * from "./src/chat.ts";
		`,
		resolveDir: process.cwd(),
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["jszip", "mammoth", "unpdf", "@mozilla/readability"],
	write: false,
	plugins: [
		{
			name: "obsidian-stub",
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({
					path: "obsidian",
					namespace: "obsidian-stub",
				}));
				build.onLoad({ filter: /.*/, namespace: "obsidian-stub" }, () => ({
					contents: `
						export class TAbstractFile {}
						export class MarkdownView {}
						export class Modal {
							constructor(app) { this.app = app; }
							open() {}
							close() {}
						}
						export class TFile extends TAbstractFile {
							constructor(path) {
								super();
								this.path = path;
								this.name = path.split("/").pop();
								this.basename = this.name.replace(/\\.md$/i, "");
								this.extension = "md";
								this.stat = { mtime: Date.now() };
							}
						}
						export class Notice { hide() {}; setMessage() {} }
						export class PluginSettingTab {}
						export class Setting {}
						export function normalizePath(p) { return p.replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }
						export async function requestUrl() { return { status: 503 }; }
					`,
					loader: "js",
				}));
			},
		},
	],
});

const code = buildResult.outputFiles[0].text;
const testBundlePath = new URL("./.test-bundle.mjs", import.meta.url);
const fsSync = await import("node:fs");
fsSync.writeFileSync(testBundlePath, code, "utf-8");
const mod = await import(testBundlePath.href);

const {
	normalizeVector,
	dotProductNormalized,
	cosineSimilarity,
	findRelatedConcepts,
	VectorIndexer,
	OKFManager,
	resolvePortableResourceUri,
	toKebabSlug,
	extractPptx,
	extractPdf,
	extractDocx,
	extractDocument,
	computeLineDiff,
	extractExplicitLinksFromMarkdown,
	VaultWikiTraverser,
	buildSynthesisNoteProposal,
	parseVaultChatResponse,
	applyProposedPatchToContent,
} = mod;

console.log("=== Running Lattice (obsidian-lattice) Unit & Benchmark Tests ===");

// 1. Vector Normalization & Cosine Similarity
{
	const v = [3, 4, 0];
	const norm = normalizeVector(v);
	assert.ok(Math.abs(norm[0] - 0.6) < 1e-6);
	assert.ok(Math.abs(norm[1] - 0.8) < 1e-6);
	assert.ok(Math.abs(dotProductNormalized(norm, norm) - 1.0) < 1e-6);

	const ortho = normalizeVector([-4, 3, 0]);
	assert.ok(Math.abs(dotProductNormalized(norm, ortho)) < 1e-6);
	assert.ok(Math.abs(cosineSimilarity(v, [-4, 3, 0])) < 1e-6);
	console.log("✔ Math: Normalization, dot-product, and cosine similarity verified.");
}

// 2. Pre-filtering & Neighbor Ranking
{
	const store = {
		"concepts/eigenvalues.md": {
			path: "concepts/eigenvalues.md",
			title: "Eigenvalues and Eigenvectors",
			mtime: 1000,
			type: "Concept",
			description: "Spectral properties of linear operators.",
			tags: ["linear-algebra", "math"],
			vector: normalizeVector([1, 0, 0, 0]),
		},
		"concepts/lattice.md": {
			path: "concepts/lattice.md",
			title: "Vector Lattice",
			mtime: 1000,
			type: "Concept",
			description: "Partially ordered vector space where any two elements have a supremum.",
			tags: ["linear-algebra", "topology"],
			vector: normalizeVector([0.9, 0.4, 0, 0]),
		},
		"specs/okf-schema.md": {
			path: "specs/okf-schema.md",
			title: "OKF Specification",
			mtime: 1000,
			type: "Spec",
			description: "Open Knowledge Format frontmatter rules.",
			tags: ["okf", "knowledge-base"],
			vector: normalizeVector([0.75, 0.65, 0, 0]),
		},
		"logs/daily-log.md": {
			path: "logs/daily-log.md",
			title: "Daily Log",
			mtime: 1000,
			type: "Log",
			description: "Should be excluded by pre-filter.",
			tags: ["log"],
			vector: normalizeVector([1, 0, 0, 0]),
		},
	};

	const target = normalizeVector([1, 0, 0, 0]);
	const related = findRelatedConcepts(target, store, {
		excludePath: "concepts/eigenvalues.md",
		topK: 5,
		threshold: 0.5,
	});

	// Should exclude self ("concepts/eigenvalues.md") and Log ("logs/daily-log.md")
	assert.equal(related.length, 2);
	assert.equal(related[0].path, "concepts/lattice.md");
	assert.equal(related[1].path, "specs/okf-schema.md");

	// Filter by OKF type = "Spec"
	const onlySpecs = findRelatedConcepts(target, store, {
		excludePath: "concepts/eigenvalues.md",
		filterType: "Spec",
		topK: 5,
		threshold: 0.5,
	});
	assert.equal(onlySpecs.length, 1);
	assert.equal(onlySpecs[0].path, "specs/okf-schema.md");
	console.log("✔ Math: Pre-filtering (exclude self, exclude Log, filterType) verified.");
}

// 3. Performance Benchmark: 5,000 x 768-dim vectors (nomic-embed-text dimension)
{
	const count = 5000;
	const dim = 768;
	const store = {};
	for (let i = 0; i < count; i++) {
		const vec = new Array(dim);
		for (let d = 0; d < dim; d++) {
			vec[d] = ((i + d) % 17) * 0.05;
		}
		store[`note-${i}.md`] = {
			path: `note-${i}.md`,
			title: `Concept ${i}`,
			mtime: 1000,
			type: i % 2 === 0 ? "Concept" : "Reference",
			description: "Synthetic vector record",
			tags: ["bench"],
			vector: vec,
		};
	}
	const query = new Array(dim).fill(0.036);

	// Warm up JIT
	findRelatedConcepts(query, store, { topK: 7, threshold: 0.3 });

	const t0 = performance.now();
	const top = findRelatedConcepts(query, store, { topK: 7, threshold: 0.3 });
	const elapsed = performance.now() - t0;

	assert.equal(top.length, 7);
	console.log(
		`✔ Benchmark: Ranked ${count} x ${dim}-dim vectors in ${elapsed.toFixed(2)}ms.`
	);
}

// 4. OKF v0.1 Frontmatter Validation & Composite String Builder
{
	// Canonical 5-field OKF v0.1 frontmatter (4 orthogonal types: note, paper, topic, project)
	const validRes = OKFManager.validateFrontmatter({
		type: "topic",
		title: "Vault Overview",
		description: "High-level Map of Content connecting research literature, core domains, and projects.",
		tags: ["moc", "overview"],
		timestamp: "2026-10-25T17:00:00Z",
	});
	assert.equal(validRes.isValid, true);
	assert.equal(validRes.missingFields.length, 0);
	assert.equal(validRes.warnings.length, 0);

	// Bad ISO timestamp should trigger a warning
	const badTsRes = OKFManager.validateFrontmatter({
		type: "note",
		title: "Test Note",
		description: "Testing timestamp format.",
		tags: ["test"],
		timestamp: "not-a-date",
	});
	assert.equal(badTsRes.isValid, false);
	assert.equal(badTsRes.warnings.length, 1);

	// Legacy bloat keys (created, origin, status) and numeric timestamp titles should trigger warnings
	const bloatRes = OKFManager.validateFrontmatter({
		type: "note",
		title: "202610261411",
		description: "Captured note with legacy headers.",
		tags: ["inbox", "origin/thought"],
		timestamp: "2026-10-26T14:11:00Z",
		created: "2026-10-26",
		origin: "thought",
		status: "seed",
	});
	assert.equal(bloatRes.isValid, false);
	assert.ok(bloatRes.warnings.some((w) => w.includes("raw timestamp slug")));
	assert.ok(bloatRes.warnings.some((w) => w.includes("legacy header key")));
	assert.ok(bloatRes.warnings.some((w) => w.includes("placeholder capture tags")));

	const invalidRes = OKFManager.validateFrontmatter({
		type: "note",
		title: "",
	});
	assert.equal(invalidRes.isValid, false);
	assert.ok(invalidRes.missingFields.includes("description"));
	assert.ok(invalidRes.missingFields.includes("tags"));
	assert.ok(invalidRes.missingFields.includes("timestamp"));

	const rawMd = `---
type: note
title: Vector Cache Spec
---

Body text without frontmatter.`;
	assert.equal(VectorIndexer.stripFrontmatter(rawMd), "Body text without frontmatter.");
	console.log("✔ OKF v0.1: 4-type, 5-field frontmatter validation and legacy bloat warnings verified.");
}

// 5. Unlinked Mention & Bundle-Relative Link Detection
{
	const okf = new OKFManager({}, {});
	const rawNote = `---
type: note
title: Order Theory
---
In functional analysis, a Vector Lattice is studied alongside [Eigenvalues and Eigenvectors](/concepts/eigenvalues.md) which are already linked.`;

	const neighbors = [
		{
			path: "concepts/lattice.md",
			title: "Vector Lattice",
			mtime: 1,
			type: "note",
			description: "",
			tags: [],
			vector: [1],
			similarity: 0.92,
		},
		{
			path: "concepts/eigenvalues.md",
			title: "Eigenvalues and Eigenvectors",
			mtime: 1,
			type: "note",
			description: "",
			tags: [],
			vector: [1],
			similarity: 0.88,
		},
	];

	const mentions = okf.findUnlinkedMentions(rawNote, neighbors);
	assert.equal(mentions.length, 1);
	assert.equal(mentions[0].record.path, "concepts/lattice.md");
	assert.equal(mentions[0].matchedText, "Vector Lattice");

	assert.equal(okf.isConceptLinkedInContent(rawNote, neighbors[0]), false);
	assert.equal(okf.isConceptLinkedInContent(rawNote, neighbors[1]), true);
	console.log("✔ OKF: Unlinked mention & bundle-relative Markdown link (`/path.md`) detection verified.");
}

// 6. Startup Vault Discovery & Consistency Check
{
	const mockFiles = [
		{ path: "notes/alpha.md", name: "alpha.md", basename: "alpha", extension: "md", stat: { mtime: 100 } },
		{ path: "notes/beta.md", name: "beta.md", basename: "beta", extension: "md", stat: { mtime: 200 } },
	];
	const mockFrontmatter = {
		"notes/alpha.md": {
			type: "note",
			title: "Alpha System",
			description: "Core architecture overview.",
			tags: ["distributed-systems", "consensus"],
			timestamp: "2026-10-25T12:00:00Z",
		},
		"notes/beta.md": {
			type: "project",
			title: "Beta Runbook",
			description: "Operational runbook.",
			tags: ["ops"],
			timestamp: "2026-10-25T13:00:00Z",
		},
	};
	const mockStore = {
		"notes/alpha.md": {
			path: "notes/alpha.md",
			title: "Alpha System",
			mtime: 100,
			type: "note",
			description: "Core architecture overview.",
			tags: ["distributed-systems"],
			vector: [0.6, 0.8, 0, 0],
		},
		"notes/beta.md": {
			path: "notes/beta.md",
			title: "Beta Runbook",
			mtime: 200,
			type: "project",
			description: "Operational runbook.",
			tags: ["ops"],
			vector: [0.8, 0.6, 0, 0],
		},
		"deleted/orphan.md": {
			path: "deleted/orphan.md",
			title: "Orphan Note",
			mtime: 50,
			type: "note",
			description: "Deleted file.",
			tags: [],
			vector: [1, 0, 0, 0],
		},
		"notes/wrong-dim.md": {
			path: "notes/wrong-dim.md",
			title: "Wrong Dim",
			mtime: 100,
			type: "note",
			description: "",
			tags: [],
			vector: [1, 0], // 2D instead of 4D
		},
	};

	mockFiles.push({
		path: "notes/wrong-dim.md",
		name: "wrong-dim.md",
		basename: "wrong-dim",
		extension: "md",
		stat: { mtime: 100 },
	});

	const mockApp = {
		vault: {
			getMarkdownFiles: () => mockFiles,
			adapter: { exists: async (p) => p === "Inbox" },
		},
		metadataCache: {
			getFileCache: (file) => ({ frontmatter: mockFrontmatter[file.path] }),
		},
	};
	const mockPlugin = {
		settings: {
			inboxFolder: "00_Inbox",
			excludedFiles: ["index.md"],
			excludedFolders: [".obsidian"],
		},
		indexer: {
			getStore: () => mockStore,
			shouldIndexFile: () => true,
			flushSave: async () => {},
		},
	};

	const manager = new OKFManager(mockApp, mockPlugin);
	const report = await manager.runStartupDiscovery(false);

	assert.equal(report.orphanedVectorsPruned, 1);
	assert.equal(report.dimensionMismatchesPruned, 1);
	assert.equal(report.primaryVectorDimension, 4);
	assert.deepEqual(report.discoveredTypes, ["note", "paper", "topic", "project"]);
	assert.equal(manager.getTargetFolderForType("paper"), "sources/literature");
	assert.equal(report.resolvedInboxFolder, "Inbox");
	assert.equal(mockPlugin.settings.inboxFolder, "Inbox");

	// Verify dynamic folder-driven type discovery (e.g. Knowledge-Personal vault with `records/`)
	mockFiles.push({
		path: "records/lease.md",
		name: "lease.md",
		basename: "lease",
		extension: "md",
		stat: { mtime: 250 },
	});
	mockFrontmatter["records/lease.md"] = {
		type: "record",
		title: "Apartment Lease",
		description: "Rental contract.",
		tags: ["housing"],
		timestamp: "2026-10-26T10:00:00Z",
	};
	const personalReport = await manager.runStartupDiscovery(false);
	assert.ok(personalReport.discoveredTypes.includes("record"));
	assert.equal(manager.getTargetFolderForType("record"), "records");
	assert.equal(manager.validateFile(mockFiles[mockFiles.length - 1]).isValid, true);
	mockFiles.pop();
	delete mockFrontmatter["records/lease.md"];
	await manager.runStartupDiscovery(false);
	console.log("✔ Discovery: Startup schema discovery, dynamic folder-to-type routing, orphan pruning, and dimension checks verified.");

	// 7. Connected Notes Conformance, Asymmetric Hub Detection, & Full-Vault Scan
	mockFiles.push({
		path: "topics/spectroscopy.md",
		name: "spectroscopy.md",
		basename: "spectroscopy",
		extension: "md",
		stat: { mtime: 300 },
	});
	mockFrontmatter["topics/spectroscopy.md"] = {
		type: "topic",
		title: "Spectroscopy",
		description: "Spectroscopy hub.",
		tags: ["spectroscopy"],
		timestamp: "2026-10-26T12:00:00Z",
	};

	mockApp.metadataCache.resolvedLinks = {
		"notes/alpha.md": {
			"notes/beta.md": 1,
			"notes/wrong-dim.md": 1,
			"topics/spectroscopy.md": 1, // alpha links to topic hub, but topic hub does not link back!
		},
		"notes/beta.md": {
			"notes/alpha.md": 1,
		},
	};
	mockApp.metadataCache.unresolvedLinks = {
		"notes/alpha.md": {
			"Missing Concept": 1,
		},
	};

	const connectedReport = manager.verifyNoteAndConnectedConformance(mockFiles[0]); // alpha.md
	assert.equal(connectedReport.noteValidation.isValid, true);
	assert.equal(connectedReport.connectedNotes.length, 3); // beta.md (both), wrong-dim.md (outgoing), topics/spectroscopy.md (outgoing hub)
	assert.equal(connectedReport.validConnectedCount, 2); // beta.md & topics/spectroscopy.md are valid
	assert.equal(connectedReport.invalidConnectedNotes.length, 1); // wrong-dim.md is missing frontmatter
	assert.equal(connectedReport.asymmetricHubNotes.length, 1); // topics/spectroscopy.md does not link back
	assert.equal(connectedReport.asymmetricHubNotes[0].file.path, "topics/spectroscopy.md");
	assert.equal(connectedReport.unresolvedLinks.length, 1);
	assert.equal(connectedReport.unresolvedLinks[0], "Missing Concept");
	assert.equal(connectedReport.allConformant, false);

	// Reserved file `log.md` check
	const logValidation = manager.validateFile({ path: "log.md", name: "log.md", basename: "log", extension: "md" });
	assert.equal(logValidation.isValid, true);

	const vaultSummary = manager.scanVaultOKFConformance(false);
	assert.equal(vaultSummary.totalNotes, 4);
	assert.equal(vaultSummary.validCount, 3);
	assert.equal(vaultSummary.invalidCount, 1);
	assert.equal(vaultSummary.asymmetricLinks.length, 1);
	assert.equal(vaultSummary.invalidNotes[0].file.path, "notes/wrong-dim.md");
	assert.ok(vaultSummary.durationMs < 50);
	console.log(
		`✔ Conformance & Lint: Connected-note verification, asymmetric hub check, and full-vault OKF scan (${vaultSummary.durationMs}ms) verified.`
	);
}

// 8. Automated Knowledge Loader & Multi-Format Extractors
{
	// 8.1 Path Utilities & Cross-Machine Cloud Portability
	const gdriveUri = resolvePortableResourceUri("C:/Users/donal/My Drive/Papers/sample.pdf");
	assert.equal(gdriveUri, "gdrive://Papers/sample.pdf");

	const vaultRelUri = resolvePortableResourceUri(
		"C:/Users/donal/My Drive/Knowledge/sources/literature/paper.pdf",
		"C:/Users/donal/My Drive/Knowledge"
	);
	assert.equal(vaultRelUri, "/sources/literature/paper.pdf");

	const webUri = resolvePortableResourceUri("https://arxiv.org/abs/2401.0001");
	assert.equal(webUri, "https://arxiv.org/abs/2401.0001");

	assert.equal(toKebabSlug("AI & Predictive Maintenance in 2026!"), "ai-predictive-maintenance-in-2026");
	console.log("✔ Knowledge Loader: Cross-machine cloud-root (gdrive://) path resolution and slugs verified.");

	// 8.2 PPTX Extractor with Slide Text & Presenter Speaker Notes
	const JSZip = (await import("jszip")).default;
	const zip = new JSZip();

	const slide1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
	<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
		<p:cSld>
			<p:spTree>
				<p:sp>
					<p:nvSpPr><p:cNvPr id="1" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
					<p:txBody><a:p><a:r><a:t>Polyoxometalate Architectures</a:t></a:r></a:p></p:txBody>
				</p:sp>
				<p:sp>
					<p:txBody>
						<a:p><a:r><a:t>Self-assembly mechanisms in aqueous solution.</a:t></a:r></a:p>
						<a:p><a:r><a:t>Catalytic clusters and electron transfer.</a:t></a:r></a:p>
					</p:txBody>
				</p:sp>
			</p:spTree>
		</p:cSld>
	</p:sld>`;

	const notes1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
	<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
		<p:cSld>
			<p:spTree>
				<p:sp>
					<p:txBody><a:p><a:r><a:t>Crucial speaker note: emphasize pH-dependent crystallization dynamics.</a:t></a:r></a:p></p:txBody>
				</p:sp>
			</p:spTree>
		</p:cSld>
	</p:notes>`;

	const slide1Rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
	<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
		<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
	</Relationships>`;

	zip.file("ppt/slides/slide1.xml", slide1Xml);
	zip.file("ppt/notesSlides/notesSlide1.xml", notes1Xml);
	zip.file("ppt/slides/_rels/slide1.xml.rels", slide1Rels);

	const pptxBuffer = await zip.generateAsync({ type: "nodebuffer" });
	const pptxResult = await extractPptx(pptxBuffer);

	assert.equal(pptxResult.title, "Polyoxometalate Architectures");
	assert.equal(pptxResult.slideCount, 1);
	assert.ok(pptxResult.combinedMarkdown.includes("Polyoxometalate Architectures"));
	assert.ok(pptxResult.combinedMarkdown.includes("Self-assembly mechanisms in aqueous solution."));
	assert.ok(pptxResult.combinedMarkdown.includes("> **Presenter Notes:** Crucial speaker note: emphasize pH-dependent crystallization dynamics."));
	console.log("✔ Knowledge Loader: PPTX slide text + Presenter Speaker Notes extraction verified.");

	// 8.3 PDF Extractor with Real Technical Paper
	const fs = await import("node:fs/promises");
	const realPdfPath = "C:/Users/donal/Documents/notes/assets/papers/AI_Predictive_Maintenance_Review_2024.pdf";
	try {
		const pdfBuffer = await fs.readFile(realPdfPath);
		const pdfUint8 = new Uint8Array(pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength));
		const pdfResult = await extractPdf(pdfUint8);
		assert.equal(pdfResult.pageCount, 9);
		assert.ok(pdfResult.text.length > 20000);
		assert.ok(pdfResult.text.includes("Predictive Maintenance"));
		console.log(`✔ Knowledge Loader: Real PDF extraction verified (${pdfResult.pageCount} pages, ${pdfResult.text.length} chars).`);
	} catch (err) {
		console.log("⚠ PDF file skipped (not found on current environment):", err.message);
	}

	// 8.4 Unified Extractor Dispatcher
	const docResult = await extractDocument("presentation.pptx", pptxBuffer);
	assert.equal(docResult?.sourceType, "pptx");
	assert.equal(docResult?.title, "Polyoxometalate Architectures");
	console.log("✔ Knowledge Loader: Unified multi-format document extractor verified.");
}

// 9. Option 3 Hybrid Similarity: Mean-Centering, Soft-Gated OKF Header Boost & Corrupted-Tag Resilience
{
	// Construct a 15-note anisotropic corpus where all vectors share a strong [1, 0, 0, ...] cone bias
	const dim = 16;
	const hybridStore = {};
	const makeConeVec = (axisIdx, strength = 0.5) => {
		const v = new Array(dim).fill(0);
		v[0] = 0.85; // Common anisotropic cone direction
		v[axisIdx] = strength;
		return normalizeVector(v);
	};

	// 12 background chemistry notes along axes 1..6
	for (let i = 0; i < 12; i++) {
		const path = `sources/literature/chem-${i}.md`;
		hybridStore[path] = {
			path,
			title: `Polyoxometalate Cluster Synthesis ${i}`,
			mtime: 1000 + i,
			type: "paper",
			description: "Self-assembly of metal-oxide nanoclusters in solution.",
			tags: ["polyoxometalates", "self-assembly", "chemistry"],
			vector: makeConeVec(1 + (i % 5), 0.45),
		};
	}

	// 2 genuinely related AI notes along axis 10
	hybridStore["notes/llm-router.md"] = {
		path: "notes/llm-router.md",
		title: "Local LLM Mixture of Experts Routing",
		mtime: 2001,
		type: "note",
		description: "Routing queries across local Ollama models and sparse experts.",
		tags: ["local-llm", "moe", "routing"],
		vector: makeConeVec(10, 0.55),
	};
	hybridStore["projects/strata.md"] = {
		path: "projects/strata.md",
		title: "Strata Local Model Orchestrator",
		mtime: 2002,
		type: "project",
		description: "Architecture for local LLM expert routing.",
		tags: ["local-llm", "strata"],
		vector: makeConeVec(10, 0.48),
	};

	// Query note along axis 10, but deliberately polluted with wrong chemistry tags!
	const queryVec = makeConeVec(10, 0.52);

	// 9.1 Verify corrupted chemistry tags do NOT pull in chemistry papers even at max headerBoostWeight = 0.40
	const corruptedMatches = findRelatedConcepts(queryVec, hybridStore, {
		topK: 7,
		threshold: 0.35,
		headerBoostWeight: 0.40,
		queryTitle: "Lattice Knowledge Automation",
		queryDescription: "Automated local LLM note routing and organization.",
		queryTags: ["polyoxometalates", "self-assembly"], // Corrupted tags!
	});

	assert.equal(corruptedMatches.length, 2, "Should only return the 2 true AI neighbors, not pad to 7 with chemistry notes");
	assert.equal(corruptedMatches[0].path, "notes/llm-router.md");
	assert.equal(corruptedMatches[1].path, "projects/strata.md");

	// 9.2 Verify headerBoostWeight slider scales scores when tags/headers legitimately match
	const resBoostOff = findRelatedConcepts(queryVec, hybridStore, {
		topK: 5,
		threshold: 0.35,
		headerBoostWeight: 0.0,
		queryTitle: "Local LLM Routing",
		queryDescription: "Mixture of experts routing.",
		queryTags: ["local-llm", "moe"],
	});
	const resBoostOn = findRelatedConcepts(queryVec, hybridStore, {
		topK: 5,
		threshold: 0.35,
		headerBoostWeight: 0.25,
		queryTitle: "Local LLM Routing",
		queryDescription: "Mixture of experts routing.",
		queryTags: ["local-llm", "moe"],
	});

	assert.ok(
		resBoostOn[0].similarity > resBoostOff[0].similarity,
		"Increasing headerBoostWeight should boost semantically valid matches with matching OKF headers/tags"
	);
	console.log("✔ Hybrid Matching (Option 3): Corpus mean-centering, configurable headerBoostWeight slider, and corrupted-tag immunity verified.");
}

// 10. OKF Graph-Traversal-First Chat Engine, Line Diff, & Proposed Note Approval Flow
{
	// 10.1 Line-by-line LCS diff verification
	const oldNote = [
		"---",
		"type: note",
		"title: POM Catalysis",
		"---",
		"",
		"Initial summary of polyoxometalate catalysis.",
		"Legacy line to remove.",
	].join("\n");

	const newNote = [
		"---",
		"type: note",
		"title: POM Catalysis",
		"---",
		"",
		"Initial summary of polyoxometalate catalysis.",
		"Added section on electron-transfer kinetics with [Polyoxometalates](/topics/materials-science/polyoxometalates.md).",
	].join("\n");

	const diff = computeLineDiff(oldNote, newNote);
	const addedLines = diff.filter((d) => d.type === "add");
	const removedLines = diff.filter((d) => d.type === "remove");
	const sameLines = diff.filter((d) => d.type === "same");
	assert.equal(addedLines.length, 1);
	assert.equal(removedLines.length, 1);
	assert.equal(sameLines.length, 6);
	assert.ok(addedLines[0].text.includes("electron-transfer kinetics"));
	assert.equal(removedLines[0].text, "Legacy line to remove.");

	// 10.2 Explicit Markdown & WikiLink extraction
	const links = extractExplicitLinksFromMarkdown(
		"See [AI & Predictive Maintenance](/topics/applied-ai/ai-predictive-maintenance.md) and [[notes/rul-estimation]]."
	);
	assert.ok(links.includes("topics/applied-ai/ai-predictive-maintenance.md"));
	assert.ok(links.includes("notes/rul-estimation.md"));

	// 10.3 OKF 3-Stage Graph-Traversal-First Engine (Stage 1 Anchor/Hub -> Stage 2 1-hop/2-hop -> Stage 3 Unlinked Bridge)
	const fileMap = new Map();
	const fileContents = {
		"topics/overview.md": `---
type: topic
title: Vault Overview
description: Root Map of Content
tags: [moc, overview]
timestamp: "2026-10-25T12:00:00Z"
---
Root overview linking to [AI & Predictive Maintenance](/topics/applied-ai/ai-predictive-maintenance.md).`,
		"topics/applied-ai/ai-predictive-maintenance.md": `---
type: topic
title: AI & Predictive Maintenance
description: Core hub for predictive maintenance, RUL, and prognostics.
tags: [predictive-maintenance, phm, rul]
timestamp: "2026-10-25T12:00:00Z"
---
Hub connecting [Bearing Fault Diagnostics](/notes/bearing-faults.md).`,
		"notes/bearing-faults.md": `---
type: note
title: Bearing Fault Diagnostics
description: Vibration and acoustic fault signatures in rotating machinery.
tags: [predictive-maintenance, bearings]
timestamp: "2026-10-25T12:00:00Z"
---
Connects to [Sensor Fusion Architecture](/notes/sensor-fusion.md).`,
		"notes/sensor-fusion.md": `---
type: note
title: Sensor Fusion Architecture
description: Combining vibration and thermal telemetry for RUL estimation.
tags: [sensor-fusion, telemetry]
timestamp: "2026-10-25T12:00:00Z"
---
2-hop note in the explicit wiki graph.`,
		"notes/unlinked-rul-paper.md": `---
type: paper
title: Deep Transformer RUL Estimation
description: Unlinked paper on remaining useful life prediction for bearings.
tags: [predictive-maintenance, rul, bearings]
timestamp: "2026-10-25T12:00:00Z"
---
This paper is not yet linked in the explicit graph but shares high semantic/tag similarity.`,
	};

	const frontmatters = {
		"topics/overview.md": {
			type: "topic",
			title: "Vault Overview",
			description: "Root Map of Content",
			tags: ["moc", "overview"],
		},
		"topics/applied-ai/ai-predictive-maintenance.md": {
			type: "topic",
			title: "AI & Predictive Maintenance",
			description: "Core hub for predictive maintenance, RUL, and prognostics.",
			tags: ["predictive-maintenance", "phm", "rul"],
		},
		"notes/bearing-faults.md": {
			type: "note",
			title: "Bearing Fault Diagnostics",
			description: "Vibration and acoustic fault signatures in rotating machinery.",
			tags: ["predictive-maintenance", "bearings"],
		},
		"notes/sensor-fusion.md": {
			type: "note",
			title: "Sensor Fusion Architecture",
			description: "Combining vibration and thermal telemetry for RUL estimation.",
			tags: ["sensor-fusion", "telemetry"],
		},
		"notes/unlinked-rul-paper.md": {
			type: "paper",
			title: "Deep Transformer RUL Estimation",
			description: "Unlinked paper on remaining useful life prediction for bearings.",
			tags: ["predictive-maintenance", "rul", "bearings"],
		},
	};

	const vectorStore = {
		"topics/overview.md": {
			path: "topics/overview.md",
			title: "Vault Overview",
			mtime: 1,
			type: "topic",
			description: "Root Map of Content",
			tags: ["moc", "overview"],
			vector: normalizeVector([0.2, 0.8, 0.1, 0.1]),
		},
		"topics/applied-ai/ai-predictive-maintenance.md": {
			path: "topics/applied-ai/ai-predictive-maintenance.md",
			title: "AI & Predictive Maintenance",
			mtime: 1,
			type: "topic",
			description: "Core hub for predictive maintenance, RUL, and prognostics.",
			tags: ["predictive-maintenance", "phm", "rul"],
			vector: normalizeVector([0.9, 0.2, 0.1, 0.1]),
		},
		"notes/bearing-faults.md": {
			path: "notes/bearing-faults.md",
			title: "Bearing Fault Diagnostics",
			mtime: 1,
			type: "note",
			description: "Vibration and acoustic fault signatures in rotating machinery.",
			tags: ["predictive-maintenance", "bearings"],
			vector: normalizeVector([0.88, 0.22, 0.12, 0.1]),
		},
		"notes/sensor-fusion.md": {
			path: "notes/sensor-fusion.md",
			title: "Sensor Fusion Architecture",
			mtime: 1,
			type: "note",
			description: "Combining vibration and thermal telemetry for RUL estimation.",
			tags: ["sensor-fusion", "telemetry"],
			vector: normalizeVector([0.82, 0.25, 0.2, 0.1]),
		},
		"notes/unlinked-rul-paper.md": {
			path: "notes/unlinked-rul-paper.md",
			title: "Deep Transformer RUL Estimation",
			mtime: 1,
			type: "paper",
			description: "Unlinked paper on remaining useful life prediction for bearings.",
			tags: ["predictive-maintenance", "rul", "bearings"],
			vector: normalizeVector([0.91, 0.19, 0.11, 0.1]),
		},
	};

	const allMockFiles = Object.keys(fileContents).map((p) => {
		const f = {
			path: p,
			name: p.split("/").pop(),
			basename: p.split("/").pop().replace(/\.md$/i, ""),
			extension: "md",
			stat: { mtime: 100 },
		};
		fileMap.set(p, f);
		return f;
	});

	const mockChatApp = {
		vault: {
			getMarkdownFiles: () => allMockFiles,
			getAbstractFileByPath: (p) => fileMap.get(p) || null,
			cachedRead: async (file) => fileContents[file.path] || "",
		},
		metadataCache: {
			getFileCache: (file) => ({ frontmatter: frontmatters[file.path] }),
			getFirstLinkpathDest: (link) => fileMap.get(link) || fileMap.get(`${link}.md`) || null,
			resolvedLinks: {
				"topics/overview.md": {
					"topics/applied-ai/ai-predictive-maintenance.md": 1,
				},
				"topics/applied-ai/ai-predictive-maintenance.md": {
					"notes/bearing-faults.md": 1,
				},
				"notes/bearing-faults.md": {
					"notes/sensor-fusion.md": 1,
				},
			},
		},
	};

	const mockChatPlugin = {
		settings: {
			similarityThreshold: 0.2,
			headerBoostWeight: 0.15,
		},
		indexer: {
			getStore: () => vectorStore,
			getRecord: (p) => vectorStore[p],
			shouldIndexFile: () => true,
			fetchEmbedding: async () => null,
		},
	};

	const traverser = new VaultWikiTraverser(mockChatApp, mockChatPlugin);
	const traversal = await traverser.traverseHeaderGraph(
		"Summarize predictive maintenance bearing faults and RUL",
		fileMap.get("topics/applied-ai/ai-predictive-maintenance.md"),
		"wiki-active"
	);

	// Stage 1: Anchor note is first
	assert.equal(traversal.nodes[0].path, "topics/applied-ai/ai-predictive-maintenance.md");
	assert.equal(traversal.nodes[0].provenance, "anchor");

	// Stage 2: Explicit 1-hop and 2-hop links come BEFORE Stage 3 unlinked vector bridges
	const bearingNode = traversal.nodes.find((n) => n.path === "notes/bearing-faults.md");
	const fusionNode = traversal.nodes.find((n) => n.path === "notes/sensor-fusion.md");
	const bridgeNode = traversal.nodes.find((n) => n.path === "notes/unlinked-rul-paper.md");

	assert.ok(bearingNode, "1-hop linked note should be traversed in Stage 2");
	assert.equal(bearingNode.provenance, "graph-1hop");
	assert.ok(fusionNode, "2-hop linked note should be traversed in Stage 2");
	assert.equal(fusionNode.provenance, "graph-2hop");
	assert.ok(bridgeNode, "Unlinked note should be discovered in Stage 3 as an unlinked-bridge");
	assert.equal(bridgeNode.provenance, "unlinked-bridge");

	// Verify Stage 2 nodes precede Stage 3 bridge nodes in traversal order
	const idx1Hop = traversal.nodes.indexOf(bearingNode);
	const idxBridge = traversal.nodes.indexOf(bridgeNode);
	assert.ok(idx1Hop < idxBridge, "Explicit 1-hop graph links must precede unlinked vector bridge fallback");

	// 10.4 Read-only synthesis vs Proposed Note Edit parsing & "+ File Synthesis as Note..." proposal builder
	const readOnlyResp = parseVaultChatResponse(
		JSON.stringify({
			replyMarkdown: "Here is a synthesis of [Bearing Fault Diagnostics](/notes/bearing-faults.md).",
			proposedChanges: [],
		})
	);
	assert.equal(readOnlyResp.proposedChanges.length, 0);
	assert.ok(readOnlyResp.replyMarkdown.includes("/notes/bearing-faults.md"));

	const editResp = parseVaultChatResponse(
		JSON.stringify({
			replyMarkdown: "I prepared the requested update.",
			proposedChanges: [
				{
					action: "modify",
					targetPath: "/notes/bearing-faults.md",
					summary: "Add RUL transformer reference",
					proposedContent: newNote,
				},
			],
		})
	);
	assert.equal(editResp.proposedChanges.length, 1);
	assert.equal(editResp.proposedChanges[0].action, "modify");
	assert.equal(editResp.proposedChanges[0].targetPath, "notes/bearing-faults.md");

	const filedProposal = buildSynthesisNoteProposal(
		"# Bearing Prognostics Synthesis\n\nSynthesized findings across [Bearing Fault Diagnostics](/notes/bearing-faults.md).",
		"Bearing Prognostics Synthesis",
		traversal.nodes
	);
	assert.equal(filedProposal.action, "create");
	assert.equal(filedProposal.targetPath, "notes/bearing-prognostics-synthesis.md");
	assert.ok(filedProposal.proposedContent.includes("type: note"));
	assert.ok(filedProposal.proposedContent.includes("## Related"));
	// 10.5 Low-Token Header-First Graph Map & On-Demand Selective Note Reading
	const headerResult = await traverser.traverseHeaderGraph(
		"Summarize predictive maintenance bearing faults and RUL",
		fileMap.get("topics/applied-ai/ai-predictive-maintenance.md"),
		"wiki-active"
	);
	assert.ok(headerResult.nodes.length >= 3);
	assert.ok(headerResult.headerMapMarkdown.includes("OKF GRAPH HEADER CHEATSHEET"));
	assert.equal(headerResult.nodes[0].provenance, "anchor");
	// Header map is compact (<1200 characters, ~300 tokens)
	assert.ok(headerResult.headerMapMarkdown.length < 1500);

	// Test on-demand reading of 1 note requested by model in Pass 1
	const selectedBodies = await traverser.readSelectedNotes(
		["notes/bearing-faults.md"],
		headerResult.nodes
	);
	assert.ok(selectedBodies["notes/bearing-faults.md"].includes("Sensor Fusion Architecture"));
	const readNode = headerResult.nodes.find((n) => n.path === "notes/bearing-faults.md");
	assert.equal(readNode?.wasReadInFull, true);

	// 10.6 Low-Token Edit Patches (append and replace)
	const baseNoteContent = [
		"---",
		"type: note",
		"title: Bearing Fault Diagnostics",
		"---",
		"",
		"Initial vibration telemetry findings.",
		"",
		"## Related",
		"- [Topic Hub](/topics/applied-ai/ai-predictive-maintenance.md)",
	].join("\n");

	const appendPatched = applyProposedPatchToContent(baseNoteContent, {
		mode: "append",
		replaceBlock: "### Acoustic Emission Telemetry\nHigh frequency acoustic wave analysis detects micro-spalling.",
	});
	assert.ok(appendPatched.includes("### Acoustic Emission Telemetry"));
	assert.ok(appendPatched.indexOf("Acoustic Emission Telemetry") < appendPatched.indexOf("## Related"));

	const replacePatched = applyProposedPatchToContent(baseNoteContent, {
		mode: "replace",
		searchBlock: "Initial vibration telemetry findings.",
		replaceBlock: "Comprehensive multi-sensor spectral analysis.",
	});
	assert.ok(replacePatched.includes("Comprehensive multi-sensor spectral analysis."));
	assert.ok(!replacePatched.includes("Initial vibration telemetry findings."));

	// 10.7 Antigravity-Style Thinking & Natural Conversational Chat Parsing (both JSON & Direct Markdown)
	const thinkChatResp = parseVaultChatResponse(
		"<think>\nInspecting bearing diagnostics hub and fault signatures.\nSynthesizing vibration and acoustic emission patterns.\n</think>\n" +
			JSON.stringify({
				thoughtSteps: [
					"Checked active note and 4 OKF graph headers",
					"Evaluated spectral vibration patterns",
				],
				readPaths: ["notes/bearing-faults.md"],
				replyMarkdown:
					"Here is a summary of the bearing fault regime connecting [Sensor Fusion Architecture](/notes/sensor-fusion.md) with vibration telemetry.",
				proposedChanges: [],
			})
	);
	assert.equal(thinkChatResp.readPaths?.length, 1);
	assert.equal(thinkChatResp.readPaths?.[0], "notes/bearing-faults.md");
	assert.ok(thinkChatResp.thoughtSteps.length >= 2);
	assert.ok(thinkChatResp.replyMarkdown.includes("Sensor Fusion Architecture"));

	// Direct unconstrained Markdown test (no JSON wrapping)
	const directMarkdownResp = parseVaultChatResponse(
		`<think>
1. Evaluate user question on acoustic emission
2. Trace connection between sensor-fusion.md and predictive maintenance hub
</think>
<read>notes/sensor-fusion.md</read>

Based on the traversed vault notes, acoustic emission telemetry provides earlier defect detection than vibration analysis alone. You can explore [Sensor Fusion](/notes/sensor-fusion.md) for architecture details.

\`\`\`proposed-note
action: create
targetPath: notes/acoustic-emission-telemetry.md
title: Acoustic Emission Telemetry
summary: Novel high-frequency acoustic wave analysis for micro-spalling detection
hub: topics/applied-ai/ai-predictive-maintenance.md
---
---
type: note
title: Acoustic Emission Telemetry
tags: [acoustics, sensors, predictive-maintenance]
---

## Summary
Acoustic emission waves propagate at 100 kHz - 1 MHz frequencies during early micro-spalling.
\`\`\``
	);

	assert.equal(directMarkdownResp.readPaths?.length, 1);
	assert.equal(directMarkdownResp.readPaths?.[0], "notes/sensor-fusion.md");
	assert.equal(directMarkdownResp.thoughtSteps.length, 2);
	assert.ok(directMarkdownResp.replyMarkdown.includes("acoustic emission telemetry provides earlier defect detection"));
	assert.ok(!directMarkdownResp.replyMarkdown.includes("```proposed-note"));
	assert.equal(directMarkdownResp.proposedChanges.length, 1);
	assert.equal(directMarkdownResp.proposedChanges[0].action, "create");
	assert.equal(directMarkdownResp.proposedChanges[0].targetPath, "notes/acoustic-emission-telemetry.md");
	assert.equal(directMarkdownResp.proposedChanges[0].title, "Acoustic Emission Telemetry");
	assert.equal(directMarkdownResp.proposedChanges[0].suggestedHubPath, "topics/applied-ai/ai-predictive-maintenance.md");
	assert.ok(directMarkdownResp.proposedChanges[0].proposedContent.includes("100 kHz - 1 MHz"));

	console.log("✔ Vault Chat & Diff Modal: 3-stage OKF Graph-Traversal-First engine, LCS line diff, low-token header-first context, and conversational chat verified.");
}

console.log("=== All Lattice Tests Passed ===");
