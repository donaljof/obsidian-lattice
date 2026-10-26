# OKF Schema, Validation & Graph Workflows

**Lattice** implements the **Open Knowledge Format (OKF v0.1)** profile with a streamlined **5-field frontmatter header** and **folder-aligned concept types**.

---

## 1. The Canonical 5-Field Frontmatter Schema

Every concept note outside `meta/` and reserved root files (`log.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `VAULT.md`) uses 5 core YAML fields:

```yaml
---
type: note
title: "Fault Detection and Diagnostics in HVAC Systems"
description: "Continuous real-time monitoring and root-cause analysis to prevent HVAC equipment wear and energy waste."
tags:
  - hvac-systems
  - fault-detection
  - predictive-maintenance
timestamp: 2026-10-25T16:40:00Z
---
```

| Field | Required | Format & Validation Rules |
| --- | --- | --- |
| `type` | **Yes** | Folder-aligned concept type (`note`, `paper`, `topic`, `project`, or a vault-discovered folder type). |
| `title` | **Yes** | Human-readable title. Raw numeric timestamp slugs (`/^\d{8,14}$/`, e.g. `"202610261411"`) are flagged as incomplete until enriched. |
| `description` | **Yes** | Single-sentence summary (used in link previews, topic hubs, and composite embeddings). |
| `tags` | **Yes** | Non-empty list of lowercase `kebab-case` tags. Notes containing only placeholder capture tags (`inbox`, `origin/thought`) are flagged for enrichment. |
| `timestamp` | **Yes** | ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:mm:ssZ`). |
| `resource` | `paper` only | Portable URI (`file:///`, `gdrive://`, or `https://`) pointing to the underlying external file or web source. |

### Legacy Header Bloat Cleanup
To prevent semantic drift across templates and notes, Lattice flags legacy duplicate keys (`created`, `origin`, `status`) as warnings and automatically strips them when you click **`Enrich OKF`**.

---

## 2. Orthogonal Document Types & Dynamic Folder Routing

By default, Lattice maps 4 orthogonal document types 1-to-1 with vault folders:

| `type` | Default Folder | Use Case |
| --- | --- | --- |
| `note` | `notes/` | Personal notes, atomic concepts, technical specs, syntheses, and meeting notes. |
| `paper` | `sources/literature/` | External sources (academic papers, books, web articles, PDFs, slide decks) backed by a `resource`. |
| `topic` | `topics/` | Maps of Content (MOCs) and domain hubs that index related notes and papers. |
| `project` | `projects/` | Active or archived projects. |

### Multi-Vault Adaptation
During startup discovery, [`OKFManager.runStartupDiscovery`](../src/okf.ts) scans existing subfolders outside `inbox/`. If a vault organizes additional entity folders (such as `records/` with `type: record` or `orgs/` with `type: org` in a Personal vault), Lattice automatically registers those `type → folder/` routes without manual configuration.

---

## 3. Lifecycle-Aware `Enrich OKF` & Deterministic Guards

Clicking **`Enrich OKF`** (or running `Lattice: Enrich OKF Frontmatter`) works both right after creating a raw note and later when note content evolves:

1. **Content-Only Tag Generation**: Prompts the local LLM (`llama3.2`) to derive 2–4 lowercase `kebab-case` tags strictly from the note's own prose—never injecting unrelated vault-wide tags.
2. **Deterministic `type` Guard**: Prevents personal notes outside `sources/` (that lack `resource`, `doi`, or `authors`) from ever being misclassified as `paper`.
3. **Timestamp & Title Normalization**: Preserves existing valid ISO 8601 `timestamp` values (or converts legacy `created: YYYY-MM-DD` to ISO 8601 UTC) and replaces numeric Zettelkasten filenames with descriptive titles.
4. **Immediate Connected-Note Check**: Immediately verifies the OKF conformance of the active note and all notes linked to or from it.

---

## 4. Connected-Note & Full-Vault Conformance (`<1ms`)

Lattice includes two zero-I/O, zero-LLM conformance auditors powered by Obsidian's in-memory `metadataCache`:

- **Connected-Note Conformance Strip**: Displayed in the sidebar below the active note. Shows how many outgoing and incoming linked notes are OKF-conformant, highlights any non-conformant neighbors with 1-click **`Fix OKF`**, and flags `ASYMMETRIC` hub links with 1-click **`+ Link Back`**.
- **Full-Vault Scan (`Scan All Notes`)**: Audits every note in the vault in `<1ms`, reporting:
  - Missing or invalid 5-field headers (with **`Fix All`** batch enrichment).
  - Unfiled staging notes in `inbox/`.
  - `ASYMMETRIC` links where a note links to a `topic` or `project` hub that does not link back.
  - `ORPHAN` notes with zero incoming links.
