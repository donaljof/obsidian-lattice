import { requestUrl } from "obsidian";
import type { LatticeSettings } from "./settings";

export interface OKFSynthesisRequest {
	sourceIdentifier: string;
	extractedTitle: string;
	rawContent: string;
	preferredType: string;
	existingConceptsContext: string;
	isTopicHub?: boolean;
}

export interface OKFSynthesisResult {
	type: string;
	title: string;
	description: string;
	tags: string[];
	markdownBody: string;
	suggestedTopic?: string;
	isTopicHub?: boolean;
}

export interface ProposedNotePatch {
	mode: "append" | "replace" | "full";
	searchBlock?: string;
	replaceBlock?: string;
	fullContent?: string;
}

export interface ProposedNoteChange {
	action: "create" | "modify";
	targetPath: string;
	title: string;
	summary: string;
	proposedContent: string;
	suggestedHubPath?: string;
	patch?: ProposedNotePatch;
	applied?: boolean;
}

export interface ChatStepPill {
	icon: "map" | "read" | "edit" | "synthesize";
	label: string;
	targetPath?: string;
}

export interface VaultChatRequest {
	userPrompt: string;
	activeNotePath?: string;
	traversedContextMarkdown?: string;
	headerMapMarkdown?: string;
	activeNoteSnippet?: string;
	selectedNoteBodies?: Record<string, string>;
	pass?: 1 | 2;
	history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface VaultChatResponse {
	thoughtSteps: string[];
	stepPills: ChatStepPill[];
	readPaths?: string[];
	replyMarkdown: string;
	proposedChanges: ProposedNoteChange[];
}

/**
 * Multi-provider LLM caller supporting Ollama (local) and Cloud APIs (Gemini, OpenAI, Anthropic).
 */
export async function synthesizeWithLLM(
	req: OKFSynthesisRequest,
	settings: LatticeSettings,
	discoveredTypes: string[]
): Promise<OKFSynthesisResult> {
	const prompt = buildSynthesisPrompt(req, discoveredTypes);
	const provider = settings.aiProvider || "auto";

	// 1. Try local Ollama if mode is "ollama" or "auto"
	if (provider === "ollama" || provider === "auto") {
		try {
			const ollamaResult = await callOllama(prompt, settings, true);
			if (ollamaResult) {
				return parseSynthesisResponse(ollamaResult, req);
			}
		} catch (err) {
			if (provider === "ollama") {
				throw new Error(`Ollama call failed: ${String(err)}`);
			}
			console.warn("Lattice: Ollama unavailable, falling back to Cloud AI...", err);
		}
	}

	// 2. Try Cloud API if provider is "cloud" or "auto" (fallback)
	if (settings.cloudApiKey) {
		try {
			const cloudResult = await callCloudProvider(prompt, settings, true);
			if (cloudResult) {
				return parseSynthesisResponse(cloudResult, req);
			}
		} catch (err) {
			console.error("Lattice: Cloud AI synthesis failed", err);
			throw new Error(`Cloud synthesis failed: ${String(err)}`);
		}
	}

	// 3. Fallback heuristic if no AI is available
	return fallbackHeuristic(req);
}

function buildSynthesisPrompt(req: OKFSynthesisRequest, discoveredTypes: string[]): string {
	const typeList = discoveredTypes.length > 0 ? discoveredTypes.join(", ") : "note, paper, topic, project";

	return [
		"You are an Open Knowledge Format (OKF) synthesizer for an Obsidian knowledge vault.",
		req.isTopicHub
			? "Create a comprehensive, curated Topic Hub for this domain."
			: "Convert the following extracted document into a structured atomic OKF concept note.",
		"Return ONLY a strict JSON object with NO markdown formatting around the JSON, with these exact keys:",
		`- "type": "${req.preferredType}" (choose from: ${typeList})`,
		'- "title": Clean, concise concept title',
		'- "description": Single-sentence high-signal summary (max 160 characters)',
		'- "tags": Array of 2 to 6 lowercase kebab-case domain tags',
		'- "suggestedTopic": Suggested topic domain slug (e.g. "materials-science", "predictive-maintenance", "applied-ai")',
		'- "markdownBody": Well-structured Markdown body. Use ## headings (e.g. ## Summary, ## Key learnings, ## Citations). Weave in relevant [[WikiLinks]] or [rel](/path.md) from the existing vault concepts provided below.',
		"",
		"Existing Vault Concepts for Cross-Linking:",
		req.existingConceptsContext || "None provided.",
		"",
		`Source Identifier: ${req.sourceIdentifier}`,
		`Original Title: ${req.extractedTitle}`,
		"Extracted Content:",
		req.rawContent.slice(0, 12000),
	].join("\n");
}

async function callOllama(
	prompt: string,
	settings: LatticeSettings,
	formatJson = false
): Promise<string | null> {
	const bodyPayload: Record<string, unknown> = {
		model: settings.chatModel || "qwen3:8b",
		prompt,
		stream: false,
	};
	if (formatJson) {
		bodyPayload.format = "json";
	}

	const res = await requestUrl({
		url: `${settings.ollamaUrl}/api/generate`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(bodyPayload),
		throw: false,
	});

	if (res.status === 200 && res.json?.response) {
		return res.json.response;
	}
	return null;
}

async function callCloudProvider(
	prompt: string,
	settings: LatticeSettings,
	formatJson = false
): Promise<string | null> {
	const provider = settings.cloudProvider || "gemini";

	if (provider === "gemini") {
		const model = settings.cloudModel || "gemini-2.5-flash";
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.cloudApiKey}`;
		const bodyPayload: Record<string, unknown> = {
			contents: [{ parts: [{ text: prompt }] }],
		};
		if (formatJson) {
			bodyPayload.generationConfig = { responseMimeType: "application/json" };
		}
		const res = await requestUrl({
			url,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(bodyPayload),
			throw: false,
		});

		if (res.status === 200 && res.json?.candidates?.[0]?.content?.parts?.[0]?.text) {
			return res.json.candidates[0].content.parts[0].text;
		}
	} else if (provider === "openai") {
		const model = settings.cloudModel || "gpt-4o-mini";
		const baseUrl = settings.cloudBaseUrl || "https://api.openai.com/v1";
		const bodyPayload: Record<string, unknown> = {
			model,
			messages: [{ role: "user", content: prompt }],
		};
		if (formatJson) {
			bodyPayload.response_format = { type: "json_object" };
		}
		const res = await requestUrl({
			url: `${baseUrl}/chat/completions`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${settings.cloudApiKey}`,
			},
			body: JSON.stringify(bodyPayload),
			throw: false,
		});

		if (res.status === 200 && res.json?.choices?.[0]?.message?.content) {
			return res.json.choices[0].message.content;
		}
	} else if (provider === "anthropic") {
		const model = settings.cloudModel || "claude-3-5-sonnet-20241022";
		const res = await requestUrl({
			url: "https://api.anthropic.com/v1/messages",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": settings.cloudApiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model,
				max_tokens: 3000,
				messages: [{ role: "user", content: prompt }],
			}),
			throw: false,
		});

		if (res.status === 200 && res.json?.content?.[0]?.text) {
			return res.json.content[0].text;
		}
	}

	return null;
}

function parseSynthesisResponse(rawJson: string, req: OKFSynthesisRequest): OKFSynthesisResult {
	try {
		// Clean markdown fences if any
		const cleaned = rawJson.replace(/```json/g, "").replace(/```/g, "").trim();
		const parsed = JSON.parse(cleaned);

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
			type: typeof parsed.type === "string" ? parsed.type : req.preferredType,
			title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : req.extractedTitle,
			description: typeof parsed.description === "string" ? parsed.description.trim() : "",
			tags,
			markdownBody: typeof parsed.markdownBody === "string" && parsed.markdownBody.trim() ? parsed.markdownBody.trim() : fallbackBody(req),
			suggestedTopic: typeof parsed.suggestedTopic === "string" ? parsed.suggestedTopic.trim() : undefined,
			isTopicHub: req.isTopicHub || parsed.type === "topic",
		};
	} catch (err) {
		console.warn("Lattice: Failed to parse LLM JSON, using fallback", err);
		return fallbackHeuristic(req);
	}
}

function fallbackBody(req: OKFSynthesisRequest): string {
	return [
		"## Summary",
		"",
		req.rawContent.slice(0, 3000),
	].join("\n");
}

function fallbackHeuristic(req: OKFSynthesisRequest): OKFSynthesisResult {
	return {
		type: req.preferredType,
		title: req.extractedTitle || "Untitled Source",
		description: `Source extracted from ${req.sourceIdentifier.split(/[\\/]/).pop()}.`,
		tags: ["source", req.preferredType],
		markdownBody: fallbackBody(req),
	};
}

/**
 * Interactive OKF Wiki Assistant caller supporting Local Ollama and Cloud APIs.
 * Defaults to read-only synthesis (`proposedChanges: []`) unless the user asks
 * to edit or create a note.
 */
/**
 * Interactive OKF Wiki Assistant caller supporting Local Ollama and Cloud APIs.
 * Operates in a low-token, Antigravity-style agent loop:
 * - Strictly grounded in vault notes (admits when info is not in the vault)
 * - Synthesizes cross-vault connections using bundle-relative links ([Title](/path.md))
 * - Suggests research areas neutrally without imposing opinions
 * - Emits concise `thoughtSteps` (<50 tokens) and interactive `clarifyingAsk` cards
 */
export async function chatWithVaultLLM(
	req: VaultChatRequest,
	settings: LatticeSettings,
	noteReader?: (paths: string[]) => Promise<Record<string, string>>
): Promise<VaultChatResponse> {
	// PASS 1: Lightweight Header-First Evaluation
	req.pass = 1;
	const pass1Prompt = buildVaultChatPrompt(req);
	const pass1Raw = await executeLLMCall(pass1Prompt, settings);
	let response = parseVaultChatResponse(pass1Raw, req.activeNotePath);

	// PASS 2: If the model determined it needs 1-2 note bodies to complete synthesis/edits
	if (
		response.readPaths &&
		response.readPaths.length > 0 &&
		noteReader
	) {
		const fetchedBodies = await noteReader(response.readPaths);
		if (Object.keys(fetchedBodies).length > 0) {
			req.pass = 2;
			req.selectedNoteBodies = fetchedBodies;
			const pass2Prompt = buildVaultChatPrompt(req);
			const pass2Raw = await executeLLMCall(pass2Prompt, settings);
			const pass2Response = parseVaultChatResponse(pass2Raw, req.activeNotePath);

			// Combine thought steps and step pills
			const combinedThoughts = [
				...response.thoughtSteps,
				...pass2Response.thoughtSteps,
			].slice(0, 5);

			response = {
				...pass2Response,
				thoughtSteps: combinedThoughts,
				readPaths: response.readPaths,
			};
		}
	}

	// Synthesize human-readable step pills for the UI
	response.stepPills = buildStepPills(req, response);
	return response;
}

async function executeLLMCall(
	prompt: string,
	settings: LatticeSettings
): Promise<string> {
	const provider = settings.aiProvider || "auto";

	if (provider === "ollama" || provider === "auto") {
		try {
			const ollamaRaw = await callOllama(prompt, settings, false);
			if (ollamaRaw) return ollamaRaw;
		} catch (err) {
			if (provider === "ollama") {
				throw new Error(`Ollama chat failed: ${String(err)}`);
			}
			console.warn("Lattice Chat: Ollama unavailable, falling back to Cloud AI...", err);
		}
	}

	if (settings.cloudApiKey) {
		try {
			const cloudRaw = await callCloudProvider(prompt, settings, false);
			if (cloudRaw) return cloudRaw;
		} catch (err) {
			throw new Error(`Cloud AI chat failed: ${String(err)}`);
		}
	}

	throw new Error(
		`No AI model reachable. Start Ollama (${settings.ollamaUrl}) or configure a Cloud API key in Lattice Settings.`
	);
}

function buildVaultChatPrompt(req: VaultChatRequest): string {
	const historyText =
		req.history && req.history.length > 0
			? [
					"Recent Conversation History:",
					...req.history.slice(-6).map((h) => `${h.role === "user" ? "USER" : "ASSISTANT"}: ${h.content}`),
					"",
			  ].join("\n")
			: "";

	const selectedNotesText =
		req.selectedNoteBodies && Object.keys(req.selectedNoteBodies).length > 0
			? [
					"=== REQUESTED NOTE BODIES (Full Text) ===",
					...Object.entries(req.selectedNoteBodies).map(
						([p, body]) => `--- /${p} ---\n${body.slice(0, 3000)}\n`
					),
			  ].join("\n")
			: "";

	return [
		"You are the Lattice OKF Wiki Assistant working inside an Open Knowledge Format (OKF v0.1) Obsidian vault.",
		"The vault is organized as an interconnected graph (Topic Hubs in `topics/`, Sources in `sources/`, Projects in `projects/`, Notes in `notes/`).",
		"",
		"CORE BEHAVIORAL GUARDRAILS:",
		"1. STRICT VAULT GROUNDING: Base your answers strictly on the provided vault headers and notes. Do NOT invent, assume, or hallucinate concepts, papers, or facts not present in the context. If an answer cannot be found in the vault, state clearly: \"This is not documented in the traversed vault notes\" rather than speculating.",
		"2. CROSS-VAULT SYNTHESIS & NATURAL CHAT: Engage in a natural, thoughtful conversation. Offer a clear, well-structured synthesis of the notes with explicit Obsidian markdown links (`[Title](/path.md)` or `[[Title]]`). If you have questions or want to clarify something, ask naturally in your conversational reply.",
		"3. NOTE CREATION & MODIFICATION CRITERIA: Most interactions are conversational back-and-forth. Propose a new note or edit ONLY when you identify a compelling, novel connection or synthesis theme across notes that warrants persisting as an atomic OKF note, or if the user explicitly asks to create or edit a note.",
		"4. OBJECTIVE RESEARCH EXPLORATION: When highlighting open questions or unexplored angles, maintain objective epistemic neutrality. Suggest areas of inquiry without imposing personal opinions or dogmatic stances (e.g., \"Areas to investigate further include:\").",
		"5. REASONING: You may think through connections first inside `<think>...</think>` tags before answering.",
		"",
		req.pass === 1
			? [
					"PASS 1 PLANNING INSTRUCTIONS:",
					"- If the OKF Header Cheatsheet + Active Note Preview are already enough to answer, answer directly.",
					"- If you need the full text of 1 or 2 specific notes from the header cheatsheet before answering, specify them on their own line like: `<read>path/to/note.md</read>`.",
			  ].join("\n")
			: "PASS 2: Synthesize the requested note bodies with the header graph to answer the user request.",
		"",
		"OUTPUT FORMAT INSTRUCTIONS:",
		"- Respond directly in clean, rich Markdown for the user.",
		"- If proposing a note creation or edit, append a block at the very end in this exact format:",
		"```proposed-note",
		"action: create",
		"targetPath: notes/suggested-topic-note.md",
		"title: Descriptive Note Title",
		"summary: 1-sentence summary of why this note is being proposed",
		"---",
		"# Title",
		"",
		"Synthesized note body here in full OKF format...",
		"```",
		"",
		historyText,
		req.headerMapMarkdown || req.traversedContextMarkdown || "No vault notes traversed.",
		req.activeNoteSnippet ? `\nActive Note Preview:\n${req.activeNoteSnippet}\n` : "",
		selectedNotesText,
		`Active Note Path: ${req.activeNotePath || "None"}`,
		`User Request: ${req.userPrompt}`,
	]
		.filter(Boolean)
		.join("\n");
}

export function parseVaultChatResponse(
	rawText: string,
	defaultTargetPath?: string
): VaultChatResponse {
	const thinkMatches: string[] = [];

	// 1. Extract <think>...</think> if emitted by local reasoning models (Qwen, DeepSeek, etc.)
	let cleanedText = rawText.replace(/<think>([\s\S]*?)<\/think>/gi, (_, match) => {
		const lines = match.split("\n").map((l: string) => l.trim()).filter(Boolean);
		thinkMatches.push(...lines.slice(0, 4));
		return "";
	}).trim();

	// 2. Extract <read>path/to/note.md</read> tags
	const readPaths: string[] = [];
	cleanedText = cleanedText.replace(/<read>([\s\S]*?)<\/read>/gi, (_, p) => {
		const clean = p.trim().replace(/^\/+/, "");
		if (clean) readPaths.push(clean);
		return "";
	}).trim();

	// 3. Extract ```proposed-note ... ``` or ```proposed-change ... ``` blocks
	const proposedChanges: ProposedNoteChange[] = [];
	cleanedText = cleanedText.replace(
		/```(?:proposed-note|proposed-change)\s*([\s\S]*?)```/gi,
		(_, block) => {
			try {
				const parts = block.split(/\n---\n/);
				const headerLines = (parts[0] || "").split("\n");
				const body = parts.slice(1).join("\n---\n").trim();

				let action: "create" | "modify" = "create";
				let targetPath = defaultTargetPath || "notes/synthesized-note.md";
				let title = "Synthesized Note";
				let summary = "Synthesized from vault notes";
				let suggestedHubPath: string | undefined;

				for (const line of headerLines) {
					const colonIdx = line.indexOf(":");
					if (colonIdx === -1) continue;
					const key = line.slice(0, colonIdx).trim().toLowerCase();
					const val = line.slice(colonIdx + 1).trim();
					if (key === "action") {
						action =
							val.toLowerCase() === "modify" || val.toLowerCase() === "edit"
								? "modify"
								: "create";
					}
					if (key === "targetpath" || key === "target_path" || key === "path") {
						targetPath = val.replace(/^\/+/, "");
					}
					if (key === "title") title = val;
					if (key === "summary") summary = val;
					if (key === "suggestedhubpath" || key === "hub") {
						suggestedHubPath = val.replace(/^\/+/, "");
					}
				}

				if (!targetPath.endsWith(".md")) targetPath += ".md";

				proposedChanges.push({
					action,
					targetPath,
					title: title || targetPath.replace(/^.*\//, "").replace(/\.md$/i, ""),
					summary,
					proposedContent: body,
					suggestedHubPath,
				});
			} catch (e) {
				console.warn("Lattice: Failed to parse proposed note block", e);
			}
			return "";
		}
	).trim();

	// 4. Backward compatibility: if the model returned legacy JSON
	if (cleanedText.startsWith("{") || cleanedText.startsWith("```json")) {
		try {
			const jsonClean = cleanedText
				.replace(/^```json\s*/i, "")
				.replace(/```\s*$/, "")
				.trim();
			const parsed = JSON.parse(jsonClean);
			if (parsed.replyMarkdown || parsed.reply || parsed.answer) {
				return parseLegacyJsonVaultChatResponse(parsed, thinkMatches, defaultTargetPath);
			}
		} catch {
			// Not valid JSON, fall through to direct markdown
		}
	}

	const thoughtSteps =
		thinkMatches.length > 0
			? thinkMatches
			: ["Evaluated request against traversed OKF graph context."];

	return {
		thoughtSteps,
		stepPills: [],
		readPaths: readPaths.slice(0, 2),
		replyMarkdown: cleanedText || "Synthesis complete based on traversed vault notes.",
		proposedChanges,
	};
}

function parseLegacyJsonVaultChatResponse(
	parsed: any,
	inheritedThinks: string[],
	defaultTargetPath?: string
): VaultChatResponse {
	const replyMarkdown =
		typeof parsed.replyMarkdown === "string" && parsed.replyMarkdown.trim()
			? parsed.replyMarkdown.trim()
			: typeof parsed.reply === "string"
			? parsed.reply.trim()
			: typeof parsed.answer === "string"
			? parsed.answer.trim()
			: "Synthesis complete based on traversed vault notes.";

	const thoughtSteps: string[] = [];
	if (Array.isArray(parsed.thoughtSteps)) {
		for (const t of parsed.thoughtSteps) {
			if (typeof t === "string" && t.trim()) thoughtSteps.push(t.trim());
		}
	} else if (inheritedThinks.length > 0) {
		thoughtSteps.push(...inheritedThinks);
	}
	if (thoughtSteps.length === 0) {
		thoughtSteps.push("Mapped OKF header graph and evaluated note context.");
	}

	const readPaths: string[] = [];
	if (Array.isArray(parsed.readPaths)) {
		for (const p of parsed.readPaths) {
			if (typeof p === "string" && p.trim()) {
				readPaths.push(p.trim().replace(/^\/+/, ""));
			}
		}
	}

	const rawChanges = Array.isArray(parsed.proposedChanges)
		? parsed.proposedChanges
		: [];
	const proposedChanges: ProposedNoteChange[] = [];

	for (const item of rawChanges) {
		if (!item || typeof item !== "object") continue;
		const rawContent =
			typeof item.proposedContent === "string"
				? item.proposedContent.trim()
				: typeof item.content === "string"
				? item.content.trim()
				: "";

		const action: "create" | "modify" =
			item.action === "modify" || item.action === "edit" ? "modify" : "create";
		const rawPath =
			typeof item.targetPath === "string" && item.targetPath.trim()
				? item.targetPath.trim().replace(/^\/+/, "")
				: action === "modify" && defaultTargetPath
				? defaultTargetPath
				: "notes/synthesized-note.md";
		const targetPath = rawPath.endsWith(".md") ? rawPath : `${rawPath}.md`;

		let patch: ProposedNotePatch | undefined;
		if (item.patch && typeof item.patch === "object") {
			patch = {
				mode:
					item.patch.mode === "append" || item.patch.mode === "replace"
						? item.patch.mode
						: "full",
				searchBlock:
					typeof item.patch.searchBlock === "string"
						? item.patch.searchBlock
						: undefined,
				replaceBlock:
					typeof item.patch.replaceBlock === "string"
						? item.patch.replaceBlock
						: undefined,
				fullContent: rawContent || undefined,
			};
		}

		proposedChanges.push({
			action,
			targetPath,
			title:
				typeof item.title === "string" && item.title.trim()
					? item.title.trim()
					: targetPath.replace(/^.*\//, "").replace(/\.md$/i, ""),
			summary:
				typeof item.summary === "string" && item.summary.trim()
					? item.summary.trim()
					: `${action === "modify" ? "Update" : "Create"} ${targetPath}`,
			proposedContent: rawContent,
			suggestedHubPath:
				typeof item.suggestedHubPath === "string"
					? item.suggestedHubPath.trim().replace(/^\/+/, "")
					: undefined,
			patch,
		});
	}

	return {
		thoughtSteps,
		stepPills: [],
		readPaths: readPaths.slice(0, 2),
		replyMarkdown,
		proposedChanges,
	};
}

function buildStepPills(
	req: VaultChatRequest,
	res: VaultChatResponse
): ChatStepPill[] {
	const pills: ChatStepPill[] = [];

	if (req.headerMapMarkdown) {
		const count = (req.headerMapMarkdown.match(/^- \[[A-Z0-9 -]+\]/gm) || []).length;
		pills.push({
			icon: "map",
			label: `Mapped ${count || "vault"} OKF headers`,
		});
	}

	if (res.readPaths && res.readPaths.length > 0) {
		for (const p of res.readPaths) {
			pills.push({
				icon: "read",
				label: `Read /${p}`,
				targetPath: p,
			});
		}
	}

	if (res.proposedChanges.length > 0) {
		pills.push({
			icon: "edit",
			label: `Proposed note for /${res.proposedChanges[0].targetPath}`,
			targetPath: res.proposedChanges[0].targetPath,
		});
	} else {
		pills.push({
			icon: "synthesize",
			label: "Synthesized response",
		});
	}

	return pills;
}
