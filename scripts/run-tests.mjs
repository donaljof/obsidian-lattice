import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import esbuild from "esbuild";

// Bundle math.ts, indexer.ts, and okf.ts in memory with a minimal obsidian stub for unit testing
const buildResult = await esbuild.build({
	stdin: {
		contents: `
			export * from "./src/math.ts";
			export { VectorIndexer } from "./src/indexer.ts";
			export { OKFManager, VALID_OKF_TYPES, VALID_OKF_STATUSES } from "./src/okf.ts";
		`,
		resolveDir: process.cwd(),
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "node",
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
const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const mod = await import(dataUrl);

const {
	normalizeVector,
	dotProductNormalized,
	cosineSimilarity,
	findRelatedConcepts,
	VectorIndexer,
	OKFManager,
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

// 4. OKF Frontmatter Validation & Composite String Builder
{
	const validRes = OKFManager.validateFrontmatter({
		type: "Concept",
		title: "Spectral Theorem",
		description: "Every self-adjoint operator can be diagonalized by a unitary matrix.",
		tags: ["linear-algebra", "spectral-theory"],
		created: "2026-10-25",
		status: "evergreen",
	});
	assert.equal(validRes.isValid, true);
	assert.equal(validRes.missingFields.length, 0);

	const invalidRes = OKFManager.validateFrontmatter({
		type: "Concept",
		title: "",
	});
	assert.equal(invalidRes.isValid, false);
	assert.ok(invalidRes.missingFields.includes("description"));
	assert.ok(invalidRes.missingFields.includes("tags"));

	const rawMd = `---
type: Spec
title: Vector Cache Spec
---

Body text without frontmatter.`;
	assert.equal(VectorIndexer.stripFrontmatter(rawMd), "Body text without frontmatter.");
	console.log("✔ OKF: Frontmatter validation and YAML stripping verified.");
}

// 5. Unlinked Mention Detection
{
	const okf = new OKFManager({}, {});
	const rawNote = `---
type: Concept
title: Order Theory
---
In functional analysis, a Vector Lattice is studied alongside [[concepts/eigenvalues|Eigenvalues and Eigenvectors]] which are already linked.`;

	const neighbors = [
		{
			path: "concepts/lattice.md",
			title: "Vector Lattice",
			mtime: 1,
			type: "Concept",
			description: "",
			tags: [],
			vector: [1],
			similarity: 0.92,
		},
		{
			path: "concepts/eigenvalues.md",
			title: "Eigenvalues and Eigenvectors",
			mtime: 1,
			type: "Concept",
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
	console.log("✔ OKF: Unlinked mention & already-linked detection verified.");
}

// 6. Startup Vault Discovery & Consistency Check
{
	const mockFiles = [
		{ path: "notes/alpha.md", name: "alpha.md", basename: "alpha", extension: "md", stat: { mtime: 100 } },
		{ path: "notes/beta.md", name: "beta.md", basename: "beta", extension: "md", stat: { mtime: 200 } },
	];
	const mockFrontmatter = {
		"notes/alpha.md": {
			type: "ArchitectureNote",
			title: "Alpha System",
			description: "Core architecture overview.",
			tags: ["distributed-systems", "consensus"],
			created: "2026-10-25",
			status: "published",
		},
		"notes/beta.md": {
			type: "Playbook",
			title: "Beta Runbook",
			description: "Operational runbook.",
			tags: ["ops"],
			created: "2026-10-25",
			status: "draft",
		},
	};
	const mockStore = {
		"notes/alpha.md": {
			path: "notes/alpha.md",
			title: "Alpha System",
			mtime: 100,
			type: "ArchitectureNote",
			description: "Core architecture overview.",
			tags: ["distributed-systems"],
			vector: [0.6, 0.8, 0, 0],
		},
		"notes/beta.md": {
			path: "notes/beta.md",
			title: "Beta Runbook",
			mtime: 200,
			type: "Playbook",
			description: "Operational runbook.",
			tags: ["ops"],
			vector: [0.8, 0.6, 0, 0],
		},
		"deleted/orphan.md": {
			path: "deleted/orphan.md",
			title: "Orphan Note",
			mtime: 50,
			type: "Concept",
			description: "Deleted file.",
			tags: [],
			vector: [1, 0, 0, 0],
		},
		"notes/wrong-dim.md": {
			path: "notes/wrong-dim.md",
			title: "Wrong Dim",
			mtime: 100,
			type: "Concept",
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
	assert.ok(report.discoveredTypes.includes("ArchitectureNote"));
	assert.ok(report.discoveredTypes.includes("Playbook"));
	assert.ok(report.discoveredStatuses.includes("published"));
	assert.ok(report.discoveredStatuses.includes("draft"));
	assert.equal(report.resolvedInboxFolder, "Inbox");
	assert.equal(mockPlugin.settings.inboxFolder, "Inbox");
	console.log("✔ Discovery: Startup schema discovery, orphan pruning, and dimension checks verified.");
}

console.log("=== All Lattice Tests Passed ===");
