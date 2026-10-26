import type { ScoredVectorRecord, VectorRecord } from "./settings";

export interface NeighborQueryOptions {
	excludePath?: string;
	filterType?: string;
	filterTags?: string[];
	filterFolder?: string;
	topK?: number;
	threshold?: number;
}

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
 * Pre-filters the in-memory vector store by OKF metadata (`type !== 'Log'`,
 * optional type, tag, and folder filters) and ranks the top-K semantic neighbors.
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
		topK = 7,
		threshold = 0.35,
	} = options;

	const normalizedTarget = normalizeVector(targetVector);
	const results: ScoredVectorRecord[] = [];
	const records = Object.values(store);

	for (let i = 0; i < records.length; i++) {
		const rec = records[i];

		// Exclude self
		if (excludePath && rec.path === excludePath) {
			continue;
		}

		// OKF boundary: always exclude 'Log', empty vectors, or mismatched embedding dimensions
		if (
			!rec.vector ||
			rec.vector.length !== normalizedTarget.length ||
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

		// Optional tag intersection filter
		if (filterTags && filterTags.length > 0) {
			const lowerRecTags = new Set(rec.tags.map((t) => t.toLowerCase()));
			const hasMatch = filterTags.some((t) =>
				lowerRecTags.has(t.toLowerCase())
			);
			if (!hasMatch) continue;
		}

		const similarity = dotProductNormalized(normalizedTarget, rec.vector);
		if (similarity >= threshold) {
			results.push({
				...rec,
				similarity,
			});
		}
	}

	results.sort((a, b) => b.similarity - a.similarity);
	return results.slice(0, topK);
}
