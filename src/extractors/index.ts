import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";
import { extractPptx } from "./pptx";
import { extractUrl } from "./url";

export interface ExtractedDocument {
	sourceType: "pptx" | "docx" | "pdf" | "url" | "text";
	title: string;
	authors?: string;
	rawText: string;
	formattedMarkdown?: string;
	pageOrSlideCount?: number;
}

/**
 * Unified extractor dispatcher.
 */
export async function extractDocument(
	source: string,
	buffer?: ArrayBuffer | Uint8Array
): Promise<ExtractedDocument | null> {
	// 1. Web URL
	if (/^https?:\/\//i.test(source)) {
		const res = await extractUrl(source);
		if (!res) return null;
		return {
			sourceType: "url",
			title: res.title,
			rawText: res.text,
		};
	}

	// 2. Buffer must be provided for binary files
	if (!buffer) {
		return null;
	}

	const lowerPath = source.toLowerCase();

	// 3. PowerPoint (.pptx)
	if (lowerPath.endsWith(".pptx")) {
		const res = await extractPptx(buffer);
		return {
			sourceType: "pptx",
			title: res.title,
			rawText: res.combinedMarkdown,
			formattedMarkdown: res.combinedMarkdown,
			pageOrSlideCount: res.slideCount,
		};
	}

	// 4. Word (.docx)
	if (lowerPath.endsWith(".docx")) {
		const res = await extractDocx(buffer);
		return {
			sourceType: "docx",
			title: res.title,
			rawText: res.markdown,
			formattedMarkdown: res.markdown,
		};
	}

	// 5. PDF (.pdf)
	if (lowerPath.endsWith(".pdf")) {
		const res = await extractPdf(buffer);
		return {
			sourceType: "pdf",
			title: res.title,
			authors: res.authors,
			rawText: res.text,
			pageOrSlideCount: res.pageCount,
		};
	}

	// 6. Plain text / Markdown
	if (lowerPath.endsWith(".md") || lowerPath.endsWith(".txt")) {
		const decoder = new TextDecoder("utf-8");
		const text = decoder.decode(buffer);
		const firstLine = text.split("\n")[0].replace(/^#+\s*/, "").trim();
		return {
			sourceType: "text",
			title: firstLine || "Untitled Text",
			rawText: text,
		};
	}

	return null;
}
