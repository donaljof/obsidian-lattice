// @ts-ignore
import mammoth from "mammoth";

export interface DocxExtractionResult {
	title: string;
	markdown: string;
}

/**
 * Extracts clean Markdown from a Word (.docx) file buffer.
 */
export async function extractDocx(
	data: ArrayBuffer | Uint8Array
): Promise<DocxExtractionResult> {
	const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
	const buffer = Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const result = await (mammoth as any).convertToMarkdown({ buffer });
	const rawMarkdown = (result && result.value) || "";

	// Detect document title from the first # Heading or first non-empty line
	let title = "";
	const lines = rawMarkdown.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("# ")) {
			title = trimmed.replace(/^#\s+/, "").trim();
			break;
		} else if (!title && !trimmed.startsWith("#") && !trimmed.startsWith("-") && trimmed.length < 120) {
			title = trimmed;
			break;
		}
	}

	return {
		title: title || "Untitled Document",
		markdown: rawMarkdown.trim(),
	};
}
