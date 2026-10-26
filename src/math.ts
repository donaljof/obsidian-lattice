import type { ScoredVectorRecord, VectorRecord } from "./settings";

export interface NeighborQueryOptions {
	excludePath?: string;
	filterType?: string;
	filterTags?: string[];
	filterFolder?: string;
	topK?: number;
	threshold?: number;
	headerBoostWeight?: number;
	queryTitle?: string;
	queryDescription?: string;
	queryTags?: string[];
	strictAutoLink?: boolean;
	disableCentering?: boolean;
	storeVersion?: number;
}

interface CentroidCacheEntry {
	count: number;
	dim: number;
	samplePath: string;
	sampleMtime: number;
	storeVersion?: number;
	centroid: number[];
	centroidNormSq: number;
	tagDocFreq: Map<string, number>;
}

const centroidCache = new WeakMap<object, CentroidCacheEntry>();

export function invalidateCentroidCache(store?: object): void {
	if (store) {
		centroidCache.delete(store);
	}
}

const IGNORED_META_TAGS = new Set([
	"inbox",
	"origin/thought",
	"untagged",
	"seed",
	"growing",
	"evergreen",
	"stale",
	"web-clip",
	"reference",
	"source",
]);

const HEADER_STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"into",
	"using",
	"based",
	"study",
	"review",
	"notes",
	"note",
	"paper",
	"book",
	"topic",
	"overview",
	"analysis",
	"via",
	"over",
	"under",
	"between",
	"through",
]);

/**
 * Normalizes a numeric vector to unit length (L2 norm = 1.0).
 * Ensures subsequent similarity checks reduce to fast dot-products.
 */
export function normalizeVector(vec: number[]): number[] {
	let sumSq = 0;
	const len = vec.length;
	for (let i = 0; i < len; i++) {
		const v = vec[i];
		sumSq += v * v;
	}
	if (sumSq === 0) return vec.slice();
	const invNorm = 1.0 / Math.sqrt(sumSq);
	const out = new Array<number>(len);
	for (let i = 0; i < len; i++) {
		out[i] = vec[i] * invNorm;
	}
	return out;
}

/**
 * Computes fast dot-product between two equal-length normalized vectors.
 * Unrolled 4x loop for V8 JIT throughput (<5ms across 15,000 vectors).
 */
export function dotProductNormalized(a: number[], b: number[]): number {
	const len = Math.min(a.length, b.length);
	if (len === 0) return 0;

	let sum0 = 0;
	let sum1 = 0;
	let sum2 = 0;
	let sum3 = 0;

	const limit = len - (len % 4);
	let i = 0;
	for (; i < limit; i += 4) {
		sum0 += a[i] * b[i];
		sum1 += a[i + 1] * b[i + 1];
		sum2 += a[i + 2] * b[i + 2];
		sum3 += a[i + 3] * b[i + 3];
	}

	let total = sum0 + sum1 + sum2 + sum3;
	for (; i < len; i++) {
		total += a[i] * b[i];
	}
	return total;
}

/**
 * Computes full cosine similarity between arbitrary vectors (safe if unnormalized).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	const len = Math.min(a.length, b.length);
	if (len === 0) return 0;

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < len; i++) {
		const va = a[i];
		const vb = b[i];
		dot += va * vb;
		normA += va * va;
		normB += vb * vb;
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

/**
 * Extracts normalized content tokens from OKF title and description headers.
 */
export function extractHeaderTokens(title?: string, description?: string): Set<string> {
	const combined = `${title || ""} ${description || ""}`.toLowerCase();
	const parts = combined.split(/[^a-z0-9]+/);
	const tokens = new Set<string>();
	for (let i = 0; i < parts.length; i++) {
		const w = parts[i];
		if (w.length >= 3 && !HEADER_STOPWORDS.has(w) && !/^\d+$/.test(w)) {
			tokens.add(w);
		}
	}
	return tokens;
}

/**
 * Computes or retrieves cached corpus centroid and tag IDF frequencies for the vector store.
 */
function getOrComputeCorpusStats(
	store: Record<string, VectorRecord>,
	records: VectorRecord[],
	targetDim: number,
	storeVersion?: number
): CentroidCacheEntry | null {
	if (records.length < 10) return null;

	const firstRec = records[0];
	const cached = centroidCache.get(store);
	if (cached && cached.dim === targetDim) {
		if (storeVersion !== undefined) {
			if (cached.storeVersion === storeVersion) {
				return cached;
			}
		} else if (
			cached.count === records.length &&
			cached.samplePath === firstRec.path &&
			cached.sampleMtime === firstRec.mtime
		) {
			return cached;
		}
	}

	const centroid = new Array<number>(targetDim).fill(0);
	const tagDocFreq = new Map<string, number>();
	let validCount = 0;

	for (let i = 0; i < records.length; i++) {
		const rec = records[i];
		if (
			!rec.vector ||
			rec.vector.length !== targetDim ||
			rec.type.toLowerCase() === "log"
		) {
			continue;
		}
		validCount++;
		const v = rec.vector;
		for (let j = 0; j < targetDim; j++) {
			centroid[j] += v[j];
		}

		if (rec.tags && rec.tags.length > 0) {
			const seenTags = new Set<string>();
			for (let t = 0; t < rec.tags.length; t++) {
				const lowerTag = rec.tags[t].toLowerCase().trim();
				if (lowerTag && !IGNORED_META_TAGS.has(lowerTag) && !seenTags.has(lowerTag)) {
					seenTags.add(lowerTag);
					tagDocFreq.set(lowerTag, (tagDocFreq.get(lowerTag) || 0) + 1);
				}
			}
		}
	}

	if (validCount < 10) return null;

	let centroidNormSq = 0;
	const invCount = 1.0 / validCount;
	for (let j = 0; j < targetDim; j++) {
		centroid[j] *= invCount;
		centroidNormSq += centroid[j] * centroid[j];
	}

	const entry: CentroidCacheEntry = {
		count: records.length,
		dim: targetDim,
		samplePath: firstRec.path,
		sampleMtime: firstRec.mtime,
		storeVersion,
		centroid,
		centroidNormSq,
		tagDocFreq,
	};
	centroidCache.set(store, entry);
	return entry;
}

/**
 * Ranks top-K semantic neighbors using:
 * 1. Corpus Mean-Centering (removes anisotropic embedding cone bias in <0.3ms)
 * 2. Soft-Gated OKF Header & Tag Boost (IDF-weighted tags + title/description overlap,
 *    scaled by `headerBoostWeight` and gated by semantic similarity to prevent false matches from bad tags)
 * 3. Adaptive per-query Z-score and relative elbow cutoff to avoid padding irrelevant links.
 */
export function findRelatedConcepts(
	targetVector: number[],
	store: Record<string, VectorRecord>,
	options: NeighborQueryOptions = {}
): ScoredVectorRecord[] {
	if (!targetVector || targetVector.length === 0) {
		return [];
	}

	const {
		excludePath,
		filterType,
		filterTags,
		filterFolder,
		topK = 5,
		threshold = 0.35,
		headerBoostWeight = 0.15,
		strictAutoLink = false,
		disableCentering = false,
	} = options;

	const targetDim = targetVector.length;
	const normalizedTarget = normalizeVector(targetVector);
	const records = Object.values(store);

	// Resolve query OKF header metadata (from options or from store[excludePath])
	const selfRecord = excludePath ? store[excludePath] : undefined;
	const qTitle = options.queryTitle ?? selfRecord?.title ?? "";
	const qDesc = options.queryDescription ?? selfRecord?.description ?? "";
	const qRawTags = options.queryTags ?? selfRecord?.tags ?? [];

	const stats = !disableCentering
		? getOrComputeCorpusStats(store, records, targetDim, options.storeVersion)
		: null;

	// If corpus stats are available and corpus exhibits anisotropy (||centroid||^2 > 0.02),
	// pre-center the query vector: tildeQ = normalize(normalizedTarget - centroid)
	const useCentering = Boolean(stats && stats.centroidNormSq > 0.02);
	let centeredQuery: number[] = normalizedTarget;
	let centeredQueryDotCentroid = 0;
	let centroidVec: number[] | null = null;
	let centroidNormSq = 0;

	if (useCentering && stats) {
		centroidVec = stats.centroid;
		centroidNormSq = stats.centroidNormSq;
		const diff = new Array<number>(targetDim);
		for (let j = 0; j < targetDim; j++) {
			diff[j] = normalizedTarget[j] - centroidVec[j];
		}
		centeredQuery = normalizeVector(diff);
		centeredQueryDotCentroid = dotProductNormalized(centeredQuery, centroidVec);
	}

	// Prepare OKF Header & Tag Boost structures if enabled
	const effectiveBoostWeight = Math.max(0, Math.min(0.5, headerBoostWeight));
	const qHeaderTokens =
		effectiveBoostWeight > 0 ? extractHeaderTokens(qTitle, qDesc) : new Set<string>();
	const qTagIdfMap = new Map<string, number>();
	let qTotalTagIdf = 0;

	if (effectiveBoostWeight > 0 && qRawTags.length > 0) {
		const corpusSize = Math.max(10, records.length);
		const dfMap = stats?.tagDocFreq;
		for (let i = 0; i < qRawTags.length; i++) {
			const cleanTag = qRawTags[i].toLowerCase().trim();
			if (!cleanTag || IGNORED_META_TAGS.has(cleanTag)) continue;
			if (qTagIdfMap.has(cleanTag)) continue;
			const df = dfMap?.get(cleanTag) ?? 1;
			const idf = Math.log(1 + corpusSize / (1 + df));
			qTagIdfMap.set(cleanTag, idf);
			qTotalTagIdf += idf;
		}
	}

	const hasQueryHeaders = qTotalTagIdf > 0 || qHeaderTokens.size > 0;

	interface CandidateEval {
		rec: VectorRecord;
		semSim: number;
		finalScore: number;
	}

	const candidates: CandidateEval[] = [];
	let sumSem = 0;
	let sumSemSq = 0;
	let evalCount = 0;

	for (let i = 0; i < records.length; i++) {
		const rec = records[i];

		// Exclude self
		if (excludePath && rec.path === excludePath) {
			continue;
		}

		// OKF boundary: always exclude 'Log', empty vectors, or mismatched embedding dimensions
		if (
			!rec.vector ||
			rec.vector.length !== targetDim ||
			rec.type.toLowerCase() === "log"
		) {
			continue;
		}

		// Optional OKF 'type' pre-filter
		if (
			filterType &&
			filterType !== "All" &&
			rec.type.toLowerCase() !== filterType.toLowerCase()
		) {
			continue;
		}

		// Optional folder prefix filter
		if (filterFolder && !rec.path.startsWith(filterFolder)) {
			continue;
		}

		// Optional explicit tag intersection filter
		if (filterTags && filterTags.length > 0) {
			const lowerRecTags = new Set(rec.tags.map((t) => t.toLowerCase()));
			const hasMatch = filterTags.some((t) =>
				lowerRecTags.has(t.toLowerCase())
			);
			if (!hasMatch) continue;
		}

		// 1. Compute base semantic similarity (centered if corpus stats active)
		let semSim: number;
		if (useCentering && centroidVec) {
			const dotQ = dotProductNormalized(centeredQuery, rec.vector);
			const dotM = dotProductNormalized(centroidVec, rec.vector);
			const candCenteredNormSq = Math.max(
				1e-6,
				1.0 - 2.0 * dotM + centroidNormSq
			);
			semSim =
				(dotQ - centeredQueryDotCentroid) / Math.sqrt(candCenteredNormSq);
		} else {
			semSim = dotProductNormalized(normalizedTarget, rec.vector);
		}

		sumSem += semSim;
		sumSemSq += semSim * semSim;
		evalCount++;

		// 2. Compute Soft-Gated OKF Header & Tag Boost (only when semSim > 0.15 floor)
		let headerBoost = 0;
		const gateFloor = useCentering ? 0.15 : 0.55;
		const gateSpan = 0.25;

		if (
			effectiveBoostWeight > 0 &&
			hasQueryHeaders &&
			semSim > gateFloor
		) {
			// 2a. IDF-weighted tag overlap
			let tagSim = 0;
			if (qTotalTagIdf > 0 && rec.tags && rec.tags.length > 0) {
				let sharedIdf = 0;
				const seenCandTags = new Set<string>();
				for (let t = 0; t < rec.tags.length; t++) {
					const ct = rec.tags[t].toLowerCase().trim();
					if (!seenCandTags.has(ct)) {
						seenCandTags.add(ct);
						const w = qTagIdfMap.get(ct);
						if (w !== undefined) {
							sharedIdf += w;
						}
					}
				}
				tagSim = sharedIdf / qTotalTagIdf;
			}

			// 2b. Title + Description token overlap
			let lexSim = 0;
			if (qHeaderTokens.size > 0 && (rec.title || rec.description)) {
				const candTokens = extractHeaderTokens(rec.title, rec.description);
				if (candTokens.size > 0) {
					let sharedTokens = 0;
					for (const tok of qHeaderTokens) {
						if (candTokens.has(tok)) sharedTokens++;
					}
					lexSim =
						sharedTokens /
						Math.sqrt(qHeaderTokens.size * candTokens.size);
				}
			}

			// Combine tag and lexical signals
			let combinedHeaderSim = 0;
			if (qTotalTagIdf > 0 && qHeaderTokens.size > 0) {
				combinedHeaderSim = 0.6 * tagSim + 0.4 * lexSim;
			} else if (qTotalTagIdf > 0) {
				combinedHeaderSim = tagSim;
			} else {
				combinedHeaderSim = lexSim;
			}

			// Multiplicative semantic gate prevents wrong tags from boosting unrelated notes
			const semanticGate = Math.min(1.0, (semSim - gateFloor) / gateSpan);
			headerBoost = semanticGate * effectiveBoostWeight * combinedHeaderSim;
		}

		const finalScore = Math.min(1.0, semSim + headerBoost);
		if (finalScore >= threshold) {
			candidates.push({
				rec,
				semSim,
				finalScore,
			});
		}
	}

	if (candidates.length === 0) {
		return [];
	}

	candidates.sort((a, b) => b.finalScore - a.finalScore);

	// 3. Adaptive Z-Score & Relative Drop-off Cutoff (active when evaluating across a real corpus >= 10 notes)
	const applyStatisticalCutoff = useCentering && evalCount >= 10;
	const meanSem = evalCount > 0 ? sumSem / evalCount : 0;
	const varianceSem =
		evalCount > 0
			? Math.max(1e-6, sumSemSq / evalCount - meanSem * meanSem)
			: 1;
	const stdSem = Math.sqrt(varianceSem);

	const minZScore = strictAutoLink ? 2.0 : 1.4;
	const relativeRatio = strictAutoLink ? 0.68 : 0.55;
	const topScore = candidates[0].finalScore;

	const results: ScoredVectorRecord[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		if (applyStatisticalCutoff) {
			const zScore = (c.semSim - meanSem) / stdSem;
			if (zScore < minZScore) continue;
			if (c.finalScore < topScore * relativeRatio) continue;
		}

		results.push({
			...c.rec,
			similarity: c.finalScore,
		});
		if (results.length >= topK) break;
	}

	return results;
}
