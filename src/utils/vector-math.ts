// ─── src/utils/vector-math.ts ───
// Optimized vector similarity calculations for production use.

/**
 * Cosine similarity between two vectors.
 * Returns value in [-1, 1]. 1 = identical direction.
 * SIMD-friendly: no branching inside the loop.
 */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Euclidean distance between two vectors.
 * Lower = more similar.
 */
export function euclideanDistance(a: Float32Array | number[], b: Float32Array | number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Batch cosine similarity: one query vs multiple targets.
 * Returns sorted by score descending.
 */
export function batchCosineSimilarity(
  query: number[],
  targets: Array<{ id: string; embedding: number[] }>,
): Array<{ id: string; score: number }> {
  const results = targets.map(({ id, embedding }) => ({
    id,
    score: cosineSimilarity(query, embedding),
  }));
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Normalize a vector to unit length in-place.
 */
export function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

/**
 * Hash a string to a 32-bit integer for cache keys.
 * Uses FNV-1a algorithm.
 */
export function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
