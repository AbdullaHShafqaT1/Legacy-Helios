import crypto from 'node:crypto';
import { Logger } from 'pino';
import { VectorStore } from './vectorStore.js';
import { EmbeddingProvider } from './embeddingProvider.js';

/**
 * Custom error thrown when the EmbeddingPipeline fails to embed or store text.
 */
export class EmbeddingPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingPipelineError';
    Object.setPrototypeOf(this, EmbeddingPipelineError.prototype);
  }
}

/**
 * Result returned after computing and storing an embedding in the vector store.
 */
export interface EmbeddingPipelineResult {
  embeddingId: string;
  dimensions: number;
}

/**
 * Standalone Embedding Pipeline foundation.
 *
 * Job: text in -> embedding computed -> embedding persisted in vector store -> reference returned.
 *
 * NOTE: This is NOT the Memory Manager (3.2). It does not expose store/query/getById
 * semantics for memory entries or canonical text content.
 */
export class EmbeddingPipeline {
  private vectorStore: VectorStore;
  private provider: EmbeddingProvider;
  private logger?: Logger;

  constructor(vectorStore: VectorStore, provider: EmbeddingProvider, logger?: Logger) {
    this.vectorStore = vectorStore;
    this.provider = provider;
    this.logger = logger;
  }

  /**
   * Generates an embedding for arbitrary input text, persists it in the vector store,
   * and returns the embedding reference ID and vector dimensions.
   *
   * @param text The input text (e.g. task descriptions, agent outputs, research summaries).
   * @param customId Optional reference ID. If not provided, a UUID is generated.
   * @returns An object containing the reference ID (`embeddingId`) and `dimensions`.
   * @throws EmbeddingPipelineError if text is empty, whitespace-only, or invalid.
   */
  async embedAndStore(text: string, customId?: string): Promise<EmbeddingPipelineResult> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      const msg = 'Cannot generate embedding: input text is empty or invalid.';
      if (this.logger) {
        this.logger.warn({ inputType: typeof text }, msg);
      }
      throw new EmbeddingPipelineError(msg);
    }

    let embedding: number[];
    try {
      embedding = await this.provider.embedText(text);
    } catch (error: any) {
      const msg = `Embedding provider failed to embed text: ${error?.message || String(error)}`;
      if (this.logger) {
        this.logger.error({ err: error }, msg);
      }
      throw new EmbeddingPipelineError(msg);
    }

    const embeddingId = customId || crypto.randomUUID();

    try {
      this.vectorStore.store(embeddingId, embedding);
      if (this.logger) {
        this.logger.debug({ embeddingId, dimensions: embedding.length }, 'Persisted embedding in vector store.');
      }
      return {
        embeddingId,
        dimensions: embedding.length,
      };
    } catch (error: any) {
      const msg = `Failed to store embedding in vector store: ${error?.message || String(error)}`;
      if (this.logger) {
        this.logger.error({ embeddingId, err: error }, msg);
      }
      throw new EmbeddingPipelineError(msg);
    }
  }
}
