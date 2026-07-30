/**
 * Interface representing a pluggable embedding provider capable of converting
 * arbitrary text into numerical feature vectors.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embedText(text: string): Promise<number[]>;
}

/**
 * Local deterministic embedding provider that converts text into a normalized
 * feature vector using character n-grams (3-grams and 4-grams) and FNV-1a hashing.
 *
 * This provides zero-network, instantaneous embeddings suitable for local-first
 * semantic similarity matching and integration testing without requiring remote APIs.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-tfidf-hash';
  readonly dimensions: number;

  constructor(dimensions = 384) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('Dimensions must be a positive integer.');
    }
    this.dimensions = dimensions;
  }

  /**
   * Generates an L2-normalized feature vector for the given input text.
   *
   * @param text The input text string to embed.
   * @returns A Promise resolving to an array of numbers of length `dimensions`.
   */
  async embedText(text: string): Promise<number[]> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Cannot embed empty or invalid text string.');
    }

    const cleaned = text.toLowerCase().replace(/\s+/g, ' ').trim();
    const vec = new Array<number>(this.dimensions).fill(0);

    // Extract character 3-grams and 4-grams
    const nGrams: string[] = [];
    for (let n = 3; n <= 4; n++) {
      for (let i = 0; i <= cleaned.length - n; i++) {
        nGrams.push(cleaned.slice(i, i + n));
      }
    }

    // Also include word tokens for short strings or lexical weight
    const words = cleaned.split(' ').filter((w) => w.length > 0);
    nGrams.push(...words);

    if (nGrams.length === 0) {
      nGrams.push(cleaned);
    }

    // Hash tokens into feature vector buckets using FNV-1a
    for (const token of nGrams) {
      const idx = Math.abs(this.fnv1aHash(token)) % this.dimensions;
      vec[idx] += 1;
    }

    // L2 normalization
    let normSq = 0;
    for (let i = 0; i < this.dimensions; i++) {
      normSq += vec[i] * vec[i];
    }

    if (normSq > 0) {
      const norm = Math.sqrt(normSq);
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] = vec[i] / norm;
      }
    }

    return vec;
  }

  /**
   * 32-bit FNV-1a hash algorithm for deterministic token bucket mapping.
   */
  private fnv1aHash(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash | 0; // Convert to 32-bit signed int
  }
}
