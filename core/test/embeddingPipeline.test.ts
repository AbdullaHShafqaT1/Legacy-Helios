import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteVectorStore } from '../src/memory/vectorStore.js';
import { LocalEmbeddingProvider } from '../src/memory/embeddingProvider.js';
import { EmbeddingPipeline, EmbeddingPipelineError } from '../src/memory/embeddingPipeline.js';

describe('EmbeddingPipeline & LocalEmbeddingProvider', () => {
  let vectorStore: SqliteVectorStore;
  let provider: LocalEmbeddingProvider;
  let pipeline: EmbeddingPipeline;

  beforeEach(() => {
    vectorStore = new SqliteVectorStore(':memory:');
    provider = new LocalEmbeddingProvider(384);
    pipeline = new EmbeddingPipeline(vectorStore, provider);
  });

  afterEach(() => {
    vectorStore.close();
  });

  it('should embed text and store the vector in the vector store returning reference ID and dimensions', async () => {
    const text = 'Implement vector store and embedding pipeline foundation for Phase 3';
    const result = await pipeline.embedAndStore(text);

    expect(result.embeddingId).toBeTypeOf('string');
    expect(result.embeddingId.length).toBeGreaterThan(0);
    expect(result.dimensions).toBe(384);

    const storedEmbedding = vectorStore.getById(result.embeddingId);
    expect(storedEmbedding).not.toBeNull();
    expect(storedEmbedding?.length).toBe(384);
  });

  it('should accept a custom reference ID when storing an embedding', async () => {
    const text = 'Custom reference ID test';
    const customId = 'custom-ref-id-999';
    const result = await pipeline.embedAndStore(text, customId);

    expect(result.embeddingId).toBe(customId);
    expect(vectorStore.getById(customId)).not.toBeNull();
  });

  it('should produce deterministic embeddings for identical strings and high similarity for related strings', async () => {
    const text1 = 'Fix database connection timeout bug in task queue';
    const text2 = 'Fix database connection timeout issue in queue';
    const text3 = 'Totally unrelated topic about baking chocolate cake in the oven';

    const emb1 = await provider.embedText(text1);
    const emb2 = await provider.embedText(text2);
    const emb3 = await provider.embedText(text3);

    // Identical text should have cosine similarity 1.0
    const emb1Again = await provider.embedText(text1);
    expect(emb1).toEqual(emb1Again);

    // Store in vector store and query
    vectorStore.store('doc-1', emb1);
    vectorStore.store('doc-2', emb2);
    vectorStore.store('doc-3', emb3);

    const results = vectorStore.query(emb1, 3);
    expect(results[0].id).toBe('doc-1');
    expect(results[0].score).toBeCloseTo(1.0, 4);
    expect(results[1].id).toBe('doc-2');
    expect(results[1].score).toBeGreaterThan(0.5); // high semantic/lexical similarity
    expect(results[2].id).toBe('doc-3');
    expect(results[2].score).toBeLessThan(results[1].score);
  });

  it('should throw EmbeddingPipelineError when called with empty string', async () => {
    await expect(pipeline.embedAndStore('')).rejects.toThrow(EmbeddingPipelineError);
    expect(vectorStore.count()).toBe(0);
  });

  it('should throw EmbeddingPipelineError when called with whitespace-only string', async () => {
    await expect(pipeline.embedAndStore('   \t\n   ')).rejects.toThrow(EmbeddingPipelineError);
    expect(vectorStore.count()).toBe(0);
  });

  it('should throw EmbeddingPipelineError when called with non-string invalid input', async () => {
    await expect(pipeline.embedAndStore(null as any)).rejects.toThrow(EmbeddingPipelineError);
    await expect(pipeline.embedAndStore(12345 as any)).rejects.toThrow(EmbeddingPipelineError);
    await expect(pipeline.embedAndStore(undefined as any)).rejects.toThrow(EmbeddingPipelineError);
  });

  it('should never store canonical text content in the vector store when embedAndStore is called', async () => {
    const secretContent = 'SECRET_CANONICAL_TEXT_DO_NOT_DUPLICATE_IN_VECTOR_STORE';
    const result = await pipeline.embedAndStore(secretContent);

    // Verify vectorStore only holds the embedding float array and reference ID, not the canonical text
    const stored = vectorStore.getById(result.embeddingId);
    expect(stored).toBeDefined();

    // Directly inspect database table columns to ensure no content column exists
    const row = (vectorStore as any).db.prepare('SELECT * FROM embeddings WHERE id = ?').get(result.embeddingId);
    expect(row).toBeDefined();
    expect(Object.keys(row)).toEqual(['id', 'embedding', 'dimensions', 'created_at']);
    expect(row.embedding).not.toContain(secretContent);
  });

  it('should throw EmbeddingPipelineError if vector store storage operation fails', async () => {
    vectorStore.close(); // closing causes subsequent store calls to fail
    await expect(pipeline.embedAndStore('test text after close')).rejects.toThrow(EmbeddingPipelineError);
  });
});
