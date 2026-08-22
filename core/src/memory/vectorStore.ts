import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Logger } from 'pino';

/**
 * Custom error thrown when the VectorStore encounters initialization or storage errors.
 */
export class VectorStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorStoreError';
    Object.setPrototypeOf(this, VectorStoreError.prototype);
  }
}

/**
 * Record structure representing an embedding vector stored in the vector store.
 */
export interface VectorRecord {
  id: string;
  embedding: number[];
}

/**
 * Result structure returned by a cosine similarity search query.
 */
export interface VectorQueryResult {
  id: string;
  score: number;
}

/**
 * Interface for a local-first vector store that holds embeddings ONLY,
 * referencing back to a SQLite memory_entries table by ID.
 */
export interface VectorStore {
  readonly type: string;
  init(): void;
  store(id: string, embedding: number[]): void;
  query(queryEmbedding: number[], topK?: number): VectorQueryResult[];
  getById(id: string): number[] | null;
  delete(id: string): boolean;
  count(): number;
  close(): void;
}

export interface KdNode {
  id: string;
  embedding: number[];
  left: KdNode | null;
  right: KdNode | null;
  splitDim: number;
}

/**
 * Local-first SQLite-backed Vector Store implementation using better-sqlite3.
 * Stores embeddings as serialized JSON float arrays and computes exact cosine similarity.
 *
 * DESIGN DECISION: Local-first SQLite Vector Store (SqliteVectorStore)
 * We select a custom SQLite-backed vector store using JSON-serialized float arrays
 * and in-process brute-force cosine similarity, NOT the sqlite-vss extension.
 *
 * Why chosen over sqlite-vss or Chroma:
 * 1. Zero native-extension load friction across platforms (relevant given cross-platform
 *    verification is still deferred to Phase 5).
 * 2. No external server process (unlike standalone ChromaDB).
 * 3. Trivial in-memory testing (':memory:') under Vitest.
 *
 * Trade-offs:
 * - Linear-scan query cost: Computes cosine similarity in memory over all stored records.
 *   This brute-force approach will need to be revisited or optimized if embedding counts grow large.
 */
export class SqliteVectorStore implements VectorStore {
  readonly type = 'sqlite-json-cosine';
  private dbPath: string;
  private db: Database.Database | null = null;
  private logger?: Logger;
  private kdRoot: KdNode | null = null;

  constructor(dbPath: string, logger?: Logger) {
    this.dbPath = dbPath;
    this.logger = logger;
    this.init();
  }

  /**
   * Initializes the vector store schema and opens the connection.
   * Throws VectorStoreError if the path is inaccessible or the database is corrupted.
   */
  init(): void {
    try {
      if (this.dbPath !== ':memory:') {
        const parentDir = path.dirname(this.dbPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
      }

      this.db = new Database(this.dbPath, { fileMustExist: false });

      // Enable foreign keys
      this.db.pragma('foreign_keys = ON');

      // Enable WAL mode for file-based databases
      if (this.dbPath !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
      }

      // Schema for storing vector embeddings only (no canonical text content)
      const schemaDdl = `
        CREATE TABLE IF NOT EXISTS embeddings (
          id TEXT PRIMARY KEY,
          embedding TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_embeddings_dimensions ON embeddings (dimensions);
      `;

      this.db.exec(schemaDdl);

      // Validate database accessibility
      const checkStmt = this.db.prepare('SELECT count(*) as cnt FROM embeddings');
      checkStmt.get();

      // Build KD-Tree index on initialization
      this.rebuildIndex();
    } catch (error: any) {
      if (this.db) {
        try {
          this.db.close();
        } catch {}
        this.db = null;
      }
      const msg = `Failed to initialize vector store at "${this.dbPath}": ${error?.message || String(error)}`;
      if (this.logger) {
        this.logger.error({ dbPath: this.dbPath, err: error }, msg);
      }
      throw new VectorStoreError(msg);
    }
  }

  /**
   * Stores an embedding vector referenced by an ID.
   *
   * @param id The reference ID linking to memory_entries.id in the main database.
   * @param embedding The float array representing the vector embedding.
   */
  store(id: string, embedding: number[]): void {
    if (!this.db) {
      throw new VectorStoreError('Vector store is not initialized.');
    }
    if (!id || id.trim() === '') {
      throw new VectorStoreError('Embedding reference ID cannot be empty.');
    }
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new VectorStoreError('Embedding vector must be a non-empty array of numbers.');
    }

    try {
      const now = new Date().toISOString();
      const insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO embeddings (id, embedding, dimensions, created_at)
        VALUES (?, ?, ?, ?)
      `);

      insertStmt.run(id, JSON.stringify(embedding), embedding.length, now);

      // Incrementally update KD-Tree index
      try {
        this.kdRoot = this.insertKdNode(this.kdRoot, id, embedding, 0);
      } catch (err: any) {
        if (this.logger) {
          this.logger.warn({ err: err.message }, 'Failed to insert node to KD-Tree incrementally. Rebuilding tree.');
        }
        this.rebuildIndex();
      }
    } catch (error: any) {
      const msg = `Failed to store embedding "${id}" in vector store: ${error?.message || String(error)}`;
      if (this.logger) {
        this.logger.error({ id, err: error }, msg);
      }
      throw new VectorStoreError(msg);
    }
  }

  /**
   * Queries the vector store for the top-K most similar embeddings using cosine similarity.
   *
   * @param queryEmbedding The query vector to compare against.
   * @param topK The maximum number of results to return (default: 5).
   * @returns An array of VectorQueryResult ordered by descending similarity score.
   */
  query(queryEmbedding: number[], topK = 5): VectorQueryResult[] {
    if (!this.db) {
      throw new VectorStoreError('Vector store is not initialized.');
    }
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      throw new VectorStoreError('Query embedding must be a non-empty array of numbers.');
    }
    if (topK <= 0) {
      throw new VectorStoreError('topK must be a positive integer.');
    }

    // Try querying the KD-Tree index first
    if (this.kdRoot) {
      try {
        const results: { id: string; score: number }[] = [];

        // Normalize query embedding for accurate metric distance pruning comparisons
        let normSq = 0;
        for (let i = 0; i < queryEmbedding.length; i++) {
          normSq += queryEmbedding[i] * queryEmbedding[i];
        }
        const queryNorm = normSq > 0 ? Math.sqrt(normSq) : 1;
        const normalizedQuery = queryEmbedding.map(v => v / queryNorm);

        this.searchKdTree(this.kdRoot, queryEmbedding, normalizedQuery, topK, results);

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
      } catch (err: any) {
        if (this.logger) {
          this.logger.warn({ err: err.message }, 'KD-Tree query failed. Falling back to linear scan.');
        }
      }
    }

    // Fallback to linear scan query
    return this.linearScanQuery(queryEmbedding, topK);
  }

  /**
   * Retrieves an embedding vector by its reference ID.
   *
   * @param id The reference ID.
   * @returns The embedding number[] if found, or null if not present.
   */
  getById(id: string): number[] | null {
    if (!this.db) {
      throw new VectorStoreError('Vector store is not initialized.');
    }
    try {
      const selectStmt = this.db.prepare('SELECT embedding FROM embeddings WHERE id = ?');
      const row = selectStmt.get(id) as { embedding: string } | undefined;
      if (!row) {
        return null;
      }
      return JSON.parse(row.embedding) as number[];
    } catch (error: any) {
      const msg = `Failed to retrieve embedding "${id}": ${error?.message || String(error)}`;
      throw new VectorStoreError(msg);
    }
  }

  /**
   * Deletes an embedding vector by its reference ID.
   *
   * @param id The reference ID.
   * @returns True if deleted, false if the ID did not exist.
   */
  delete(id: string): boolean {
    if (!this.db) {
      throw new VectorStoreError('Vector store is not initialized.');
    }
    try {
      const deleteStmt = this.db.prepare('DELETE FROM embeddings WHERE id = ?');
      const info = deleteStmt.run(id);
      
      if (info.changes > 0) {
        // Rebuild index on deletion to rebalance tree and purge tombstone reference IDs
        this.rebuildIndex();
        return true;
      }
      return false;
    } catch (error: any) {
      const msg = `Failed to delete embedding "${id}": ${error?.message || String(error)}`;
      throw new VectorStoreError(msg);
    }
  }

  /**
   * Returns the total number of stored vector embeddings.
   */
  count(): number {
    if (!this.db) {
      throw new VectorStoreError('Vector store is not initialized.');
    }
    try {
      const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM embeddings');
      const row = countStmt.get() as { count: number };
      return row.count;
    } catch (error: any) {
      const msg = `Failed to count embeddings: ${error?.message || String(error)}`;
      throw new VectorStoreError(msg);
    }
  }

  /**
   * Closes the underlying database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Calculates exact cosine similarity between two equal-length numerical vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Performs brute-force linear-scan matching over database rows (fallback query route).
   */
  private linearScanQuery(queryEmbedding: number[], topK: number): VectorQueryResult[] {
    try {
      const dimensions = queryEmbedding.length;
      const selectStmt = this.db!.prepare('SELECT id, embedding FROM embeddings WHERE dimensions = ?');
      const rows = selectStmt.all(dimensions) as { id: string; embedding: string }[];

      const results: VectorQueryResult[] = [];
      for (const row of rows) {
        const storedEmbedding = JSON.parse(row.embedding) as number[];
        const score = this.cosineSimilarity(queryEmbedding, storedEmbedding);
        results.push({ id: row.id, score });
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, topK);
    } catch (err: any) {
      throw new VectorStoreError(`Linear scan query failed: ${err.message}`);
    }
  }

  /**
   * Rebuilds the KD-Tree index from scratch.
   */
  private rebuildIndex(): void {
    if (!this.db) return;
    try {
      const selectStmt = this.db.prepare('SELECT id, embedding FROM embeddings');
      const rows = selectStmt.all() as { id: string; embedding: string }[];

      const records = rows.map(r => ({
        id: r.id,
        embedding: JSON.parse(r.embedding) as number[]
      }));

      if (records.length === 0) {
        this.kdRoot = null;
        return;
      }

      this.kdRoot = this.buildKdTree(records, 0);
      if (this.logger) {
        this.logger.info({ count: records.length }, 'KD-Tree index rebuilt successfully.');
      }
    } catch (err: any) {
      if (this.logger) {
        this.logger.warn({ err: err.message }, 'Failed to rebuild KD-Tree index. Falling back to linear scan.');
      }
      this.kdRoot = null;
    }
  }

  private buildKdTree(records: { id: string; embedding: number[] }[], depth: number): KdNode | null {
    if (records.length === 0) return null;

    const dimensions = records[0].embedding.length;
    const dim = depth % dimensions;

    records.sort((a, b) => a.embedding[dim] - b.embedding[dim]);
    const medianIdx = Math.floor(records.length / 2);
    const medianRecord = records[medianIdx];

    return {
      id: medianRecord.id,
      embedding: medianRecord.embedding,
      splitDim: dim,
      left: this.buildKdTree(records.slice(0, medianIdx), depth + 1),
      right: this.buildKdTree(records.slice(medianIdx + 1), depth + 1)
    };
  }

  private insertKdNode(root: KdNode | null, id: string, embedding: number[], depth: number): KdNode {
    if (root === null) {
      return {
        id,
        embedding,
        splitDim: depth % embedding.length,
        left: null,
        right: null
      };
    }

    if (root.id === id) {
      root.embedding = embedding;
      return root;
    }

    const dim = root.splitDim;
    if (embedding[dim] < root.embedding[dim]) {
      root.left = this.insertKdNode(root.left, id, embedding, depth + 1);
    } else {
      root.right = this.insertKdNode(root.right, id, embedding, depth + 1);
    }
    return root;
  }

  private searchKdTree(
    node: KdNode | null,
    queryVec: number[],
    normalizedQuery: number[],
    topK: number,
    bestResults: { id: string; score: number }[]
  ): void {
    if (node === null) return;

    if (node.embedding.length !== queryVec.length) {
      throw new Error(`Dimension mismatch: query dimension ${queryVec.length} does not match node dimension ${node.embedding.length}`);
    }

    const score = this.cosineSimilarity(queryVec, node.embedding);
    this.addQueryResult(bestResults, { id: node.id, score }, topK);

    const dim = node.splitDim;
    const splitVal = node.embedding[dim];
    const queryVal = queryVec[dim];

    let nextNode: KdNode | null = null;
    let otherNode: KdNode | null = null;

    if (queryVal < splitVal) {
      nextNode = node.left;
      otherNode = node.right;
    } else {
      nextNode = node.right;
      otherNode = node.left;
    }

    this.searchKdTree(nextNode, queryVec, normalizedQuery, topK, bestResults);

    // Prune standard other subtrees using Euclidean projection of unit vectors
    let nodeNormSq = 0;
    for (let i = 0; i < node.embedding.length; i++) {
      nodeNormSq += node.embedding[i] * node.embedding[i];
    }
    const nodeNorm = nodeNormSq > 0 ? Math.sqrt(nodeNormSq) : 1;
    const normalizedSplitVal = splitVal / nodeNorm;
    const normalizedQueryVal = normalizedQuery[dim];

    const distToHyperplaneSq = (normalizedQueryVal - normalizedSplitVal) * (normalizedQueryVal - normalizedSplitVal);

    let shouldSearchOther = true;
    if (bestResults.length === topK) {
      const worstScore = bestResults[bestResults.length - 1].score;
      const worstDistSq = 2 * (1 - worstScore);
      if (distToHyperplaneSq >= worstDistSq) {
        shouldSearchOther = false;
      }
    }

    if (shouldSearchOther) {
      this.searchKdTree(otherNode, queryVec, normalizedQuery, topK, bestResults);
    }
  }

  private addQueryResult(list: { id: string; score: number }[], item: { id: string; score: number }, topK: number): void {
    const existing = list.findIndex(r => r.id === item.id);
    if (existing !== -1) {
      if (item.score > list[existing].score) {
        list[existing].score = item.score;
        list.sort((a, b) => b.score - a.score);
      }
      return;
    }

    let insertIdx = 0;
    while (insertIdx < list.length && list[insertIdx].score >= item.score) {
      insertIdx++;
    }

    if (insertIdx < topK) {
      list.splice(insertIdx, 0, item);
      if (list.length > topK) {
        list.pop();
      }
    }
  }
}
