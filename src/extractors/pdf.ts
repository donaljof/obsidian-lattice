import { extractText, getDocumentProxy, getMeta } from "unpdf";

export interface PdfExtractionResult {
	title: string;
	authors: string;
	pageCount: number;
	text: string;
}

/**
 * Extracts clean text and metadata from a PDF file buffer using a single DocumentProxy.
 */
export async function extractPdf(
	data: ArrayBuffer | Uint8Array
): Promise<PdfExtractionResult> {
	const uint8Array =
		data instanceof Uint8Array
			? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
			: new Uint8Array(data);

	const doc = await getDocumentProxy(uint8Array);

	let metaTitle = "";
	let metaAuthor = "";
	try {
		const meta = await getMeta(doc);
		if (meta?.info) {
			const info = meta.info as Record<string, unknown>;
			if (
				typeof info.Title === "string" &&
				!info.Title.toLowerCase().includes("untitled") &&
				!info.Title.toLowerCase().includes("paper title (use style")
			) {
				metaTitle = info.Title.trim();
			}
			if (typeof info.Author === "string") {
				metaAuthor = info.Author.trim();
			}
		}
	} catch {
		// Ignore meta read failure and fall back to text analysis
	}

	const result = await extractText(doc, { mergePages: true });
	const fullText = typeof result === "string" ? result : result.text || "";
	const pageCount =
		typeof result === "object" && typeof result.totalPages === "number"
			? result.totalPages
			: doc.numPages || 1;

	// If metadata title was generic or absent, look for title in first non-empty lines
	let title = metaTitle;
	if (!title) {
		const lines = fullText
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);

		for (const l of lines.slice(0, 5)) {
			if (l.length >= 10 && !/^(doi|issn|isbn|vol\.|volume|http|page)/i.test(l)) {
				title = l;
				break;
			}
		}
	}

	return {
		title: title || "Untitled Paper",
		authors: metaAuthor,
		pageCount,
		text: fullText.trim(),
	};
}
