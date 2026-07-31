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

    try {
      const dimensions = queryEmbedding.length;
      const selectStmt = this.db.prepare('SELECT id, embedding FROM embeddings WHERE dimensions = ?');
      const rows = selectStmt.all(dimensions) as { id: string; embedding: string }[];

      const results: VectorQueryResult[] = [];
      for (const row of rows) {
        const storedEmbedding = JSON.parse(row.embedding) as number[];
        const score = this.cosineSimilarity(queryEmbedding, storedEmbedding);
        results.push({ id: row.id, score });
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, topK);
    } catch (error: any) {
      const msg = `Failed to query vector store: ${error?.message || String(error)}`;
      if (this.logger) {
        this.logger.error({ err: error }, msg);
      }
      throw new VectorStoreError(msg);
    }
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
      return info.changes > 0;
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
}
