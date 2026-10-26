# Lattice (`obsidian-lattice`)

**Lattice** is a local-first **Open Knowledge Format (OKF)**, **Semantic Vector Engine**, and **Conversational Wiki Assistant** plugin for Obsidian. It pairs sub-millisecond in-memory vector similarity search (via local [Ollama](https://ollama.com/) embeddings) with graph-traversal-first conversational chat, interactive diff approval modals, `<1ms` graph conformance auditing, reciprocal cross-linking, and multi-format document ingestion (PDF, PPTX + speaker notes, DOCX, and Web URLs).

---

## Key Capabilities

### 1. Lattice Connect & Hybrid Semantic Ranking
- **Dual-Mode Sidebar (`[Connect | Chat]`)**: Switch effortlessly between **Lattice Connect** (ambient related concepts, unlinked mentions, and graph conformance) and **Lattice Chat** (conversational vault synthesis) with a stable, pinned toggle header.
- **Local Embeddings via Ollama**: Incremental `mtime`-based indexing using `nomic-embed-text` (or any configured Ollama embedding model).
- **Anisotropy-Corrected Hybrid Ranking (Option 3)**: Combines corpus mean-centered cosine similarity with a soft-gated lexical title and OKF tag boost (`headerBoostWeight` slider in settings) so top-K neighbor suggestions remain sharp without vulnerability to corrupted or hallucinated tags.
- **Sub-Millisecond Performance**: Ranks 5,000 × 768-dimensional vectors in **~5ms** in pure TypeScript with zero native dependencies.
- **Shared CLI Vector Cache (`.okf/vectors.json`)**: Automatically exports normalized embeddings so external CLI tools and AI agents (Claude Code, Antigravity, Python scripts) can query vault similarity without re-embedding.

### 2. Lattice Chat & Graph-Traversal Wiki Assistant
- **3-Stage OKF Graph-Traversal-First Engine**:
  1. *Stage 1 (Anchor Resolution)*: Identifies the active note, explicit `[[WikiLinks]]` / `/path.md` mentions in your prompt, and candidate Topic Hubs (`topics/*.md`).
  2. *Stage 2 (Explicit Graph Traversal)*: Traverses 1-hop and 2-hop connected notes via outgoing links, incoming backlinks, and parent Topic Hubs to construct a low-token header cheatsheet.
  3. *Stage 3 (Option 3 Vector Fallback)*: Triggers vector similarity *only* if explicit graph links are sparse, surfacing unlinked semantic bridges with an interactive `+` button to link them into your active note.
- **Strict Vault Grounding & Epistemic Neutrality**: The assistant bases answers strictly on traversed notes and frontmatter headers. If information is not in the vault, it explicitly states so rather than speculating. Explores open research angles objectively without imposing opinions.
- **Local Reasoning & Unconstrained Markdown**: Generates fluent, unconstrained Markdown (no robotic JSON grammar constraints) and natively parses `<think>...</think>` tags from models like `qwen3:8b` or DeepSeek into clean, collapsible `Thought (X steps)` drawers.
- **Pop-up Diff & Approval Modal (`NoteChangeApprovalModal`)**:
  - Most interactions remain conversational Q&A.
  - When the assistant discovers a novel synthesis theme or when you explicitly ask to create/edit a note, it presents a wide (`900px`) Pop-up Diff Modal.
  - Inspect visual line-by-line diffs (`+added`, `-removed`), edit the Markdown directly, configure reciprocal Topic Hub wiring, and accept or reject changes before anything touches your vault.
- **Per-Note Chat History & Cross-Note Continuity**: Switching notes in Obsidian automatically displays that note's chat thread while retaining conversational context in memory across note switches.

### 3. Open Knowledge Format (OKF) Enrichment & Conformance
- **Canonical 5-Field Frontmatter**: Standardizes notes around 5 core YAML fields (`type`, `title`, `description`, `tags`, `timestamp` in ISO 8601 UTC), plus bibliographic fields (`resource`, `authors`, `year`, `venue`, `doi`) on external sources.
- **Zero-Config Folder-Driven Type Discovery**: Defaults to 4 orthogonal types (`note` → `notes/`, `paper` → `sources/literature/`, `topic` → `topics/`, `project` → `projects/`) and automatically learns any additional folder-backed types present in the vault during `<2ms` startup discovery.
- **Lifecycle-Aware `Enrich OKF`**: Generates or refreshes frontmatter strictly from note prose, strips legacy header bloat (`created`, `origin`, `status`) and placeholder capture tags (`inbox`, `origin/thought`), and replaces raw timestamp titles with human-readable titles.
- **Connected-Note & Full-Vault Conformance (`<1ms`)**: Verifies the active note, its outgoing/incoming linked notes, and the entire vault in memory—flagging missing fields, `ASYMMETRIC` hub links (with 1-click **`+ Link Back`**), `inbox/` staging notes, and `ORPHAN` concepts.
- **1-Click `File → <folder>/` (`okf-refactor`)**: Moves enriched notes out of `inbox/` into their canonical `type` folder with a lowercase `kebab-case` filename and logs the operation to `log.md`.

### 4. Single-Click Cross-Linking & Mention Detection
- **Bundle-Relative Links & WikiLinks**: Inserts bundle-relative Markdown links (`[Title](/path/to/note.md)`) under `## Related` or converts unlinked prose mentions in-place, while recognizing existing `[[WikiLinks]]`.
- **Automatic Reciprocal Hub Linking**: Linking a note to a `topic` or `project` hub automatically adds the reciprocal link back on the hub so your graph stays symmetric.

### 5. Automated Knowledge Loader (PDF, PPTX, DOCX, Web & Folders)
- **100% Pure TypeScript Extractors**: Ingests local `.pdf` papers, `.pptx` slide decks (including presenter speaker notes), `.docx` documents, `.md`/`.txt` files, entire folders, or web URLs without requiring Python or external runtimes.
- **AI Synthesis**: Extracts structured `# Summary`, `# Key learnings`, and `# Citations` via local Ollama (`qwen3:8b`) or Cloud API fallback (Google Gemini, Anthropic Claude, OpenAI) and cross-links the new concept into matching Topic Hubs.
- **Cross-Machine Cloud Path Portability (`gdrive://`)**: Converts local Google Drive paths into portable `gdrive://` or vault-relative URIs.

---

## Quickstart & Installation

### Step 1: Set Up Local Ollama Models
1. Install [Ollama](https://ollama.com/) and pull the recommended embedding and chat models:
   ```bash
   ollama pull nomic-embed-text
   ollama pull qwen3:8b
   ```
   *(Note: `llama3.2`, `mistral`, and other models are also supported; Lattice dynamically discovers your installed Ollama models in Settings).*
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

## Daily Workflow

1. **Lattice Connect**: Click the **Network** ribbon icon (`Lattice: Open Connect`) to inspect ambient related concepts, unlinked mentions, and OKF conformance for the active note.
2. **Lattice Chat**: Switch to **Chat** in the header to ask questions, explore cross-vault connections, or synthesize new concepts anchored to your notes and topic hubs.
3. **Review & Approve Edits**: When the assistant suggests a new note or edit, review the visual diff in the Pop-up Modal, make any adjustments, and click **Accept & Create Note**.
4. **Capture & Ingest**:
   - Use `Ctrl+P` → `Lattice: Ingest Source or Topic` to convert external PDFs, PPTX decks, DOCX files, or URLs into structured OKF concept notes.
   - Jot down quick notes in `inbox/` and click **`Enrich OKF`** to generate the canonical 5-field YAML header and file them into `notes/`, `topics/`, or `sources/`.

---

## Command Palette Reference

| Command | Description |
| --- | --- |
| `Lattice: Open Lattice Connect Sidebar` | Opens the Lattice Connect view (related concepts & conformance). |
| `Lattice: Open Lattice Chat Sidebar` | Opens the Lattice Chat view (conversational wiki assistant). |
| `Lattice: Enrich OKF Frontmatter (Current Note)` | Generates/normalizes the 5-field OKF header for the active note and verifies connected notes. |
| `Lattice: Scan All Notes & Check OKF Conformance` | Runs an in-memory (`<1ms`) conformance and graph lint scan across the entire vault. |
| `Lattice: Ingest Source or Topic (File, Folder, URL)` | Opens the Knowledge Loader modal for PDF, PPTX, DOCX, URL, or batch folder ingestion. |
| `Lattice: Clip Single URL to OKF Note` | Quickly extracts an article URL into an atomic OKF note. |
| `Lattice: Insert Related OKF Concepts` | Appends unlinked top semantic neighbors under `## Related` in the active note. |
| `Lattice: Batch Enrich OKF Frontmatter in Inbox Folder` | Batch-enriches all incomplete notes in the configured `inbox/` folder. |
| `Lattice: Run Vault Discovery & Consistency Check` | Re-runs startup schema discovery, orphan vector pruning, and dimension validation. |
| `Lattice: Sync Vector Cache with External CLI (.okf/vectors.json)` | Re-syncs vector cache with external CLI modifications. |
| `Lattice: Update Vault OKF index.md Catalog` | Generates a grouped Markdown catalog of all indexed OKF concepts. |

---

## Technical Documentation (`/docs`)

Detailed architecture and design documentation is located in [`/docs`](./docs):

- **[Architecture & Hybrid Vector Engine (`docs/architecture.md`)](./docs/architecture.md)** — Module breakdown, corpus mean-centered cosine similarity + lexical header boosting math, startup discovery, and `.okf/vectors.json` specification.
- **[OKF Schema, Validation & Graph Workflows (`docs/okf-schema-and-workflows.md`)](./docs/okf-schema-and-workflows.md)** — The 5-field frontmatter contract, dynamic `type ↔ folder` routing, deterministic type guards, connected-note conformance, and symmetric hub linking.
- **[Automated Knowledge Loader (`docs/knowledge-loader.md`)](./docs/knowledge-loader.md)** — PDF/PPTX/DOCX/Web extraction pipelines, pure TypeScript extractors, and cross-machine `gdrive://` URI resolution.
