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
			const ollamaResult = await callOllama(prompt, settings);
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
			const cloudResult = await callCloudProvider(prompt, settings);
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

async function callOllama(prompt: string, settings: LatticeSettings): Promise<string | null> {
	const res = await requestUrl({
		url: `${settings.ollamaUrl}/api/generate`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: settings.chatModel || "llama3.2",
			prompt,
			format: "json",
			stream: false,
		}),
		throw: false,
	});

	if (res.status === 200 && res.json?.response) {
		return res.json.response;
	}
	return null;
}

async function callCloudProvider(prompt: string, settings: LatticeSettings): Promise<string | null> {
	const provider = settings.cloudProvider || "gemini";

	if (provider === "gemini") {
		const model = settings.cloudModel || "gemini-2.5-flash";
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.cloudApiKey}`;
		const res = await requestUrl({
			url,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
				generationConfig: {
					responseMimeType: "application/json",
				},
			}),
			throw: false,
		});

		if (res.status === 200 && res.json?.candidates?.[0]?.content?.parts?.[0]?.text) {
			return res.json.candidates[0].content.parts[0].text;
		}
	} else if (provider === "openai") {
		const model = settings.cloudModel || "gpt-4o-mini";
		const baseUrl = settings.cloudBaseUrl || "https://api.openai.com/v1";
		const res = await requestUrl({
			url: `${baseUrl}/chat/completions`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${settings.cloudApiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				response_format: { type: "json_object" },
			}),
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
