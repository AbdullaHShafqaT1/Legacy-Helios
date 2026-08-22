import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { SqliteVectorStore } from '../src/memory/vectorStore.js';

describe('Phase 15 Vector Indexing tests & benchmarks', () => {
  let store: SqliteVectorStore;
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    store = new SqliteVectorStore(':memory:', logger);
  });

  afterEach(() => {
    store.close();
  });

  it('correctly retrieves identical query results compared to brute-force linear scan', () => {
    // Insert 50 random vectors of length 384
    const dimensions = 384;
    const numVectors = 50;

    for (let i = 0; i < numVectors; i++) {
      const vec = Array.from({ length: dimensions }, () => Math.random() - 0.5);
      // L2 normalization
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      const normalizedVec = vec.map(v => v / (norm || 1));
      store.store(`vec_${i}`, normalizedVec);
    }

    // Generate a normalized query vector
    const queryVec = Array.from({ length: dimensions }, () => Math.random() - 0.5);
    const queryNorm = Math.sqrt(queryVec.reduce((sum, v) => sum + v * v, 0));
    const normalizedQuery = queryVec.map(v => v / (queryNorm || 1));

    // Get index results
    const indexedResults = store.query(normalizedQuery, 5);

    // Get linear scan results by bypassing index (e.g. using the private fallback method)
    const bruteResults = (store as any).linearScanQuery(normalizedQuery, 5);

    expect(indexedResults.length).toBe(bruteResults.length);
    for (let i = 0; i < indexedResults.length; i++) {
      expect(indexedResults[i].id).toBe(bruteResults[i].id);
      expect(Math.abs(indexedResults[i].score - bruteResults[i].score)).toBeLessThan(1e-5);
    }
  });

  it('falls back gracefully to linear scan on dimension mismatch or unexpected failures', () => {
    store.store('vec_1', Array(384).fill(0.1));
    store.store('vec_2', Array(384).fill(0.2));

    // Query with a vector of size 128 (mismatch with stored dimensions of 384)
    // The KD-tree will throw a dimension mismatch error internally, which will be caught,
    // and the store will fall back to linearScanQuery. Since linearScanQuery filters by dimension,
    // it will scan rows matching dimensions=128 (returning empty array rather than crashing).
    const results = store.query(Array(128).fill(0.1), 5);
    expect(results).toEqual([]);
  });

  it('benchmarks query latency at 100, 1000, and 10000 scales', () => {
    const dimensions = 384;
    const scales = [100, 1000, 10000];

    console.log('\n===== VECTOR SEARCH BENCHMARK RESULTS (DIMENSIONS = 384) =====');

    for (const scale of scales) {
      const tempStore = new SqliteVectorStore(':memory:', logger);
      
      // Populate store
      for (let i = 0; i < scale; i++) {
        const vec = Array.from({ length: dimensions }, () => Math.random() - 0.5);
        const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
        const normalizedVec = vec.map(v => v / (norm || 1));
        tempStore.store(`item_${i}`, normalizedVec);
      }

      // Generate a normalized query
      const queryVec = Array.from({ length: dimensions }, () => Math.random() - 0.5);
      const queryNorm = Math.sqrt(queryVec.reduce((sum, v) => sum + v * v, 0));
      const normalizedQuery = queryVec.map(v => v / (queryNorm || 1));

      // Warm up
      tempStore.query(normalizedQuery, 5);

      // Measure brute force scan
      const t0 = performance.now();
      for (let j = 0; j < 50; j++) {
        (tempStore as any).linearScanQuery(normalizedQuery, 5);
      }
      const t1 = performance.now();
      const bruteAvgTimeMs = (t1 - t0) / 50;

      // Measure indexed KD-tree
      const t2 = performance.now();
      for (let j = 0; j < 50; j++) {
        tempStore.query(normalizedQuery, 5);
      }
      const t3 = performance.now();
      const indexAvgTimeMs = (t3 - t2) / 50;

      console.log(`Scale ${scale.toString().padStart(5, ' ')} entries:`);
      console.log(`  - Brute Force Linear Scan: ${bruteAvgTimeMs.toFixed(4)} ms / query`);
      console.log(`  - KD-Tree Indexed Search:  ${indexAvgTimeMs.toFixed(4)} ms / query`);
      console.log(`  - Speedup Factor:          ${(bruteAvgTimeMs / (indexAvgTimeMs || 1)).toFixed(2)}x`);

      tempStore.close();
    }
    console.log('===============================================================\n');
  });
});
