import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteVectorStore, VectorStoreError } from '../src/memory/vectorStore.js';

describe('SqliteVectorStore', () => {
  let store: SqliteVectorStore;
  let tempDir: string;

  beforeEach(() => {
    store = new SqliteVectorStore(':memory:');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vss-test-'));
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should initialize successfully with an in-memory SQLite database', () => {
    expect(store.type).toBe('sqlite-vss');
    expect(store.count()).toBe(0);
  });

  it('should fail fast and throw VectorStoreError on startup if given an invalid path or directory', () => {
    // In SQLite, passing an existing directory path as a DB file causes open/query to fail immediately
    expect(() => new SqliteVectorStore(tempDir)).toThrow(VectorStoreError);
  });

  it('should fail fast and throw VectorStoreError on startup if database file is corrupted', () => {
    const corruptPath = path.join(tempDir, 'corrupt.db');
    fs.writeFileSync(corruptPath, 'this is not a valid sqlite database header at all!!');
    expect(() => new SqliteVectorStore(corruptPath)).toThrow(VectorStoreError);
  });

  it('should store an embedding vector referenced by ID without storing any text content', () => {
    const embedding = [0.1, 0.2, 0.3, 0.4];
    store.store('emb-001', embedding);

    expect(store.count()).toBe(1);
    const retrieved = store.getById('emb-001');
    expect(retrieved).toEqual(embedding);

    const nonExistent = store.getById('missing-id');
    expect(nonExistent).toBeNull();
  });

  it('should query top-K embeddings sorted descending by cosine similarity score', () => {
    store.store('vec-identical', [1, 0, 0]);
    store.store('vec-similar', [0.866, 0.5, 0]); // 30 degrees, cos ~= 0.866
    store.store('vec-orthogonal', [0, 1, 0]); // 90 degrees, cos = 0
    store.store('vec-opposite', [-1, 0, 0]); // 180 degrees, cos = -1

    const results = store.query([1, 0, 0], 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe('vec-identical');
    expect(results[0].score).toBeCloseTo(1.0, 4);
    expect(results[1].id).toBe('vec-similar');
    expect(results[1].score).toBeCloseTo(0.866, 3);
    expect(results[2].id).toBe('vec-orthogonal');
    expect(results[2].score).toBeCloseTo(0.0, 4);
  });

  it('should delete an embedding by ID and return true if deleted or false if non-existent', () => {
    store.store('emb-del', [0.5, 0.5]);
    expect(store.count()).toBe(1);

    const deleted = store.delete('emb-del');
    expect(deleted).toBe(true);
    expect(store.count()).toBe(0);

    const deletedAgain = store.delete('emb-del');
    expect(deletedAgain).toBe(false);
  });

  it('should throw VectorStoreError if invalid inputs are passed to store or query', () => {
    expect(() => store.store('', [1, 2, 3])).toThrow(VectorStoreError);
    expect(() => store.store('emb-x', [])).toThrow(VectorStoreError);
    expect(() => store.query([], 5)).toThrow(VectorStoreError);
    expect(() => store.query([1, 2, 3], 0)).toThrow(VectorStoreError);
  });
});
