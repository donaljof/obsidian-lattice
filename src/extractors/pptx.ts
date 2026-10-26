import JSZip from "jszip";

export interface PptxSlideContent {
	slideNumber: number;
	title: string;
	bodyText: string[];
	speakerNotes: string;
}

export interface PptxExtractionResult {
	title: string;
	slideCount: number;
	slides: PptxSlideContent[];
	combinedMarkdown: string;
}

/**
 * Extracts slide text and speaker notes from a PPTX (Open XML) archive buffer.
 */
export async function extractPptx(
	data: ArrayBuffer | Uint8Array
): Promise<PptxExtractionResult> {
	const zip = await JSZip.loadAsync(data);

	// Find all slide XML files: ppt/slides/slide{N}.xml
	const slideFiles: { num: number; path: string }[] = [];
	zip.forEach((relativePath) => {
		const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
		if (match) {
			slideFiles.push({ num: parseInt(match[1], 10), path: relativePath });
		}
	});

	slideFiles.sort((a, b) => a.num - b.num);

	// Also find all notes slide files: ppt/notesSlides/notesSlide{N}.xml
	const notesFilesMap = new Map<number, string>();
	zip.forEach((relativePath) => {
		const match = relativePath.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/i);
		if (match) {
			notesFilesMap.set(parseInt(match[1], 10), relativePath);
		}
	});

	const slides: PptxSlideContent[] = [];
	let deckTitle = "";

	for (let i = 0; i < slideFiles.length; i++) {
		const slideEntry = slideFiles[i];
		const slideXml = await zip.file(slideEntry.path)?.async("string");
		if (!slideXml) continue;

		const slideNumber = i + 1;
		const { title, paragraphs } = parseSlideXml(slideXml);

		if (!deckTitle && title) {
			deckTitle = title;
		}

		// Try to find corresponding notes slide
		// Check slide rels first to see if there is a target notesSlide
		let speakerNotes = "";
		const relsPath = `ppt/slides/_rels/slide${slideEntry.num}.xml.rels`;
		const relsXml = await zip.file(relsPath)?.async("string");
		if (relsXml) {
			const notesMatch = relsXml.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/i);
			if (notesMatch) {
				const notesPath = `ppt/notesSlides/${notesMatch[1]}`;
				const notesXml = await zip.file(notesPath)?.async("string");
				if (notesXml) {
					speakerNotes = parseNotesXml(notesXml);
				}
			}
		}

		// Fallback: match by numerical index if not resolved via rels
		if (!speakerNotes && notesFilesMap.has(slideEntry.num)) {
			const notesXml = await zip.file(notesFilesMap.get(slideEntry.num)!)?.async("string");
			if (notesXml) {
				speakerNotes = parseNotesXml(notesXml);
			}
		}

		slides.push({
			slideNumber,
			title: title || `Slide ${slideNumber}`,
			bodyText: paragraphs,
			speakerNotes,
		});
	}

	if (!deckTitle && slides.length > 0) {
		deckTitle = slides[0].title;
	}

	// Build combined Markdown representation
	const mdSections: string[] = [];
	for (const slide of slides) {
		mdSections.push(`### Slide ${slide.slideNumber}: ${slide.title}`);
		if (slide.bodyText.length > 0) {
			for (const p of slide.bodyText) {
				mdSections.push(`- ${p}`);
			}
		}
		if (slide.speakerNotes && slide.speakerNotes.trim()) {
			mdSections.push("");
			mdSections.push(`> **Presenter Notes:** ${slide.speakerNotes.trim()}`);
		}
		mdSections.push("");
	}

	return {
		title: deckTitle || "Untitled Presentation",
		slideCount: slides.length,
		slides,
		combinedMarkdown: mdSections.join("\n").trim(),
	};
}

/**
 * Parses slide XML into title and distinct text paragraphs.
 */
function parseSlideXml(xml: string): { title: string; paragraphs: string[] } {
	let title = "";
	const paragraphs: string[] = [];

	// Match paragraphs <a:p>...</a:p>
	const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi;
	let pMatch: RegExpExecArray | null;

	while ((pMatch = pRegex.exec(xml)) !== null) {
		const pContent = pMatch[1];
		// Extract all text tokens <a:t>...</a:t> within this paragraph
		const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
		let tMatch: RegExpExecArray | null;
		let paraText = "";

		while ((tMatch = tRegex.exec(pContent)) !== null) {
			paraText += decodeXmlEntities(tMatch[1]);
		}

		paraText = paraText.trim();
		if (!paraText) continue;

		// Check if this paragraph is part of a title placeholder
		if (!title && (xml.indexOf(`type="title"`) !== -1 || xml.indexOf(`type="ctrTitle"`) !== -1)) {
			// If paragraph belongs to title shape
			if (xml.slice(Math.max(0, pMatch.index - 300), pMatch.index).includes(`type="title"`) ||
				xml.slice(Math.max(0, pMatch.index - 300), pMatch.index).includes(`type="ctrTitle"`)) {
				title = paraText;
				continue;
			}
		}

		if (!title && paragraphs.length === 0) {
			title = paraText;
		} else {
			paragraphs.push(paraText);
		}
	}

	return { title, paragraphs };
}

/**
 * Extracts presenter notes from a notesSlide XML document.
 * Filters out slide headers/numbers (typically in placeholder shapes).
 */
function parseNotesXml(xml: string): string {
	const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
	let match: RegExpExecArray | null;
	const tokens: string[] = [];

	while ((match = tRegex.exec(xml)) !== null) {
		const text = decodeXmlEntities(match[1]).trim();
		if (text && !/^\d+$/.test(text)) {
			tokens.push(text);
		}
	}

	return tokens.join(" ").replace(/\s{2,}/g, " ").trim();
}

function decodeXmlEntities(str: string): string {
	return str
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}
