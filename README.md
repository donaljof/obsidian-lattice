# Lattice (`obsidian-lattice`)

**Lattice** is a local-first **Open Knowledge Format (OKF)** and **Semantic Vector Engine** plugin for Obsidian. It pairs sub-millisecond in-memory vector similarity search (via local [Ollama](https://ollama.com/) embeddings) with automated OKF frontmatter enrichment, `<1ms` graph conformance auditing, reciprocal cross-linking, and multi-format document ingestion (PDF, PPTX + speaker notes, DOCX, and Web URLs).

---

## Key Capabilities

### 1. Semantic Vector Indexing & Hybrid Ranking
- **Local Embeddings via Ollama**: Incremental `mtime`-based indexing using `nomic-embed-text` (or any configured Ollama embedding model).
- **Anisotropy-Corrected Hybrid Ranking**: Combines corpus mean-centered cosine similarity with lexical title/tag header boosting (`headerBoostWeight`) so top-K neighbor suggestions remain sharp even in domain-specific vaults.
- **Performance**: Ranks 5,000 × 768-dimensional vectors in **~3ms** in pure TypeScript with zero native dependencies.
- **Shared CLI Vector Cache (`.okf/vectors.json`)**: Automatically exports normalized embeddings so external CLI tools and AI agents (Claude Code, Antigravity, Python scripts) can query vault similarity without re-embedding.

### 2. Open Knowledge Format (OKF) Enrichment & Conformance
- **Canonical 5-Field Frontmatter**: Standardizes notes around 5 core YAML fields (`type`, `title`, `description`, `tags`, `timestamp` in ISO 8601 UTC), plus bibliographic fields (`resource`, `authors`, `year`, `venue`, `doi`) on external sources.
- **Zero-Config Folder-Driven Type Discovery**: Defaults to 4 orthogonal types (`note` → `notes/`, `paper` → `sources/literature/`, `topic` → `topics/`, `project` → `projects/`) and automatically learns any additional folder-backed types present in the vault during `<2ms` startup discovery.
- **Lifecycle-Aware `Enrich OKF`**: Generates or refreshes frontmatter strictly from the note's prose, strips legacy header bloat (`created`, `origin`, `status`) and placeholder capture tags (`inbox`, `origin/thought`), and replaces raw timestamp titles (`202610261411`) with human-readable titles.
- **Connected-Note & Full-Vault Conformance (`<1ms`)**: Verifies the active note, its outgoing/incoming linked notes, and the entire vault in memory—flagging missing fields, `ASYMMETRIC` hub links (with 1-click **`+ Link Back`**), `inbox/` staging notes, and `ORPHAN` concepts.
- **1-Click `File → <folder>/` (`okf-refactor`)**: Moves enriched notes out of `inbox/` into their canonical `type` folder with a lowercase `kebab-case` filename and logs the operation to `log.md`.

### 3. Single-Click Cross-Linking & Mention Detection
- **Bundle-Relative Links & WikiLinks**: Inserts bundle-relative Markdown links (`[Title](/path/to/note.md)`) under `## Related` or converts unlinked prose mentions in-place, while recognizing existing `[[WikiLinks]]`.
- **Automatic Reciprocal Hub Linking**: Linking a note to a `topic` or `project` hub automatically adds the reciprocal link back on the hub so your graph stays symmetric.

### 4. Automated Knowledge Loader (PDF, PPTX, DOCX, Web & Folders)
- **Multi-Format Extraction**: Ingests local `.pdf` papers, `.pptx` slide decks (including presenter speaker notes), `.docx` documents, `.md`/`.txt` files, entire folders, or web URLs.
- **2-Pass AI Synthesis**: Extracts structured `# Summary`, `# Key learnings`, and `# Citations` via local Ollama or Cloud API fallback (Google Gemini, Anthropic Claude, OpenAI) and cross-links the new concept into matching Topic Hubs.
- **Cross-Machine Cloud Path Portability (`gdrive://`)**: Converts local Google Drive paths into portable `gdrive://` or vault-relative URIs.

---

## Quickstart & Installation

### Step 1: Set Up Local Ollama Models
1. Install [Ollama](https://ollama.com/) and pull the default embedding and chat models:
   ```bash
   ollama pull nomic-embed-text
   ollama pull llama3.2
   ```
2. Verify Ollama is running (`http://localhost:11434`).

### Step 2: Install Lattice in Obsidian

#### Option A: Via BRAT (Recommended — Auto-Updates)
1. Install **BRAT** from Obsidian's Community Plugins.
2. Open **Settings → BRAT → Add Beta plugin** and enter:
   ```text
   donaljof/obsidian-lattice
   ```
3. Enable **Lattice** under **Settings → Community plugins**.

#### Option B: Manual Download from Releases
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest GitHub Release](../../releases/latest).
2. Copy them into your vault at:
   ```text
   <Vault>/.obsidian/plugins/lattice/
   ```
3. Reload Obsidian (`Ctrl+R`) and enable **Lattice** under **Settings → Community plugins**.

#### Option C: Build from Source
```powershell
git clone https://github.com/donaljof/obsidian-lattice.git
cd obsidian-lattice
npm install
npm run build
npm test

# Copy to your Obsidian vault
$target = "C:\Path\To\Vault\.obsidian\plugins\lattice"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item "main.js", "manifest.json", "styles.css" -Destination $target -Force
```

---

## Daily Workflow in 4 Steps

1. **Open the Lattice Sidebar**: Click the **Network** ribbon icon (`Lattice: Open Related Concepts`) to open the right-hand semantic sidebar.
2. **Capture & Enrich**: Jot down a quick note in `inbox/` (or any folder) and click **`Enrich OKF`** in the sidebar. Lattice generates the 5-field YAML header (`type`, `title`, `description`, `tags`, `timestamp`) and checks connected notes.
3. **File from Inbox**: Click **`File → notes/`** (or `sources/literature/`, `topics/`, `projects/`) to rename the note to a `kebab-case` slug, move it to its canonical folder, and record the entry in `log.md`.
4. **Cross-Link & Audit**:
   - Click **`+ Cross-Link`** on any suggested semantic neighbor or unlinked mention to weave bidirectional links.
   - Click **`Scan All Notes`** in the Vault OKF Conformance bar to audit all notes, fix missing headers, or repair asymmetric hub links in `<1ms`.

---

## Command Palette Reference

| Command | Description |
| --- | --- |
| `Lattice: Open Related Concepts` | Opens the Lattice sidebar view. |
| `Lattice: Enrich OKF Frontmatter (Current Note)` | Generates/normalizes the 5-field OKF header for the active note and verifies connected notes. |
| `Lattice: Scan All Notes & Check OKF Conformance` | Runs an in-memory (`<1ms`) conformance and graph lint scan across the entire vault. |
| `Lattice: Ingest External File, Folder, or URL into OKF` | Opens the Knowledge Loader modal for PDF, PPTX, DOCX, URL, or batch folder ingestion. |
| `Lattice: Insert Related OKF Concepts` | Appends all unlinked top semantic neighbors under `## Related` in the active note. |
| `Lattice: Batch Enrich Inbox Notes (OKF)` | Batch-enriches all incomplete notes in the configured `inbox/` folder. |
| `Lattice: Run Vault Discovery & Consistency Check` | Re-runs startup schema discovery, orphan vector pruning, and dimension validation. |
| `Lattice: Sync Vault Vector Index (Incremental)` | Indexes new or modified notes based on `mtime`. |
| `Lattice: Rebuild Full Vector Index` | Re-embeds all indexable notes across the vault from scratch. |
| `Lattice: Update Vault Index (index.md)` | Generates a grouped Markdown catalog of all indexed OKF concepts. |

---

## Technical Documentation (`/docs`)

Detailed architecture and design documentation is located in [`/docs`](./docs):

- **[Architecture & Hybrid Vector Engine (`docs/architecture.md`)](./docs/architecture.md)** — Module breakdown, corpus mean-centered cosine similarity + lexical header boosting math, startup discovery, and `.okf/vectors.json` specification.
- **[OKF Schema, Validation & Graph Workflows (`docs/okf-schema-and-workflows.md`)](./docs/okf-schema-and-workflows.md)** — The 5-field frontmatter contract, dynamic `type ↔ folder` routing, deterministic type guards, connected-note conformance, and symmetric hub linking.
- **[Automated Knowledge Loader (`docs/knowledge-loader.md`)](./docs/knowledge-loader.md)** — PDF/PPTX/DOCX/Web extraction pipelines, 2-pass LLM synthesis, and cross-machine `gdrive://` URI resolution.
