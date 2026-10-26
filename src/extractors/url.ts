import { Readability } from "@mozilla/readability";
import { requestUrl } from "obsidian";

export interface UrlExtractionResult {
	title: string;
	url: string;
	excerpt: string;
	text: string;
}

/**
 * Fetches HTML from a URL and extracts clean article text and metadata via Readability.
 */
export async function extractUrl(url: string): Promise<UrlExtractionResult | null> {
	const response = await requestUrl({
		url,
		method: "GET",
		headers: {
			Accept: "text/html,application/xhtml+xml",
		},
		throw: false,
	});

	if (response.status < 200 || response.status >= 400 || !response.text) {
		return null;
	}

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
		return null;
	}

	return {
		title: rawTitle,
		url,
		excerpt: article?.excerpt?.trim() || "",
		text: cleanText,
	};
}
