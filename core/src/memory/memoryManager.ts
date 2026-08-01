import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { Config } from '../lib/config.js';
import { PermissionGatekeeper } from '../permissions/gatekeeper.js';
import { AuditLog } from '../permissions/auditLog.js';
import { VectorStore } from './vectorStore.js';
import { EmbeddingProvider } from './embeddingProvider.js';
import { EmbeddingPipeline } from './embeddingPipeline.js';

export class MemoryManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryManagerError';
    Object.setPrototypeOf(this, MemoryManagerError.prototype);
  }
}

export class RedactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionValidationError';
    Object.setPrototypeOf(this, RedactionValidationError.prototype);
  }
}

export interface StoreMemoryInput {
  content: string;
  sourceAgent: string;
  sourceTaskId?: string | null;
  tag?: string;
}

export interface MemoryEntry {
  id: string;
  content: string;
  embeddingId: string;
  sourceAgent: string;
  sourceTaskId: string | null;
  tag: string;
  timestamp: string;
}

export interface MemoryQueryFilters {
  tag?: string;
  sourceAgent?: string;
  limit?: number;
}

/**
 * MemoryManager orchestrates the storage, semantic query, and retrieval of agent memories.
 *
 * Implements:
 * 1. Pattern-based redaction check to reject obvious credentials before storage.
 * 2. Two-step write-consistency: stores embedding first, then SQLite row. Rollbacks vector on SQLite write failure.
 * 3. Configurable retention limit bounding database growth using FIFO oldest eviction.
 * 4. Audit Log decision/outcome tracking for mutating writes.
 * 5. Permission Gatekeeper integration (mutating writes requiring gatekeeper validation, passive reads auto-approved).
 */
export class MemoryManager {
  private db: Database.Database;
  private vectorStore: VectorStore;
  private embeddingPipeline: EmbeddingPipeline;
  private embeddingProvider: EmbeddingProvider;
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private logger: Logger;
  private config: Config;

  constructor(
    db: Database.Database,
    vectorStore: VectorStore,
    embeddingPipeline: EmbeddingPipeline,
    embeddingProvider: EmbeddingProvider,
    gatekeeper: PermissionGatekeeper,
    auditLog: AuditLog,
    logger: Logger,
    config: Config
  ) {
    this.db = db;
    this.vectorStore = vectorStore;
    this.embeddingPipeline = embeddingPipeline;
    this.embeddingProvider = embeddingProvider;
    this.gatekeeper = gatekeeper;
    this.auditLog = auditLog;
    this.logger = logger;
    this.config = config;
  }

  /**
   * Evaluates text content against regex patterns to catch obvious credentials.
   * Rejects store operations immediately if a secret pattern triggers.
   */
  private checkRedaction(content: string): void {
    const AWS_KEY_PATTERN = /AKIA[0-9A-Z]{16}/;
    const CLAUDE_OPENAI_KEY_PATTERN = /sk-(?:ant-|proj-)?[a-zA-Z0-9]{20,}/;
    const GENERIC_TOKEN_HEX_PATTERN = /\b[a-fA-F0-9]{32,64}\b/;
    const GENERIC_TOKEN_BASE64_PATTERN = /\b[A-Za-z0-9+/]{40,}={0,2}\b/;

    if (AWS_KEY_PATTERN.test(content)) {
      throw new RedactionValidationError('AWS Access Key ID detected in content; write rejected.');
    }
    if (CLAUDE_OPENAI_KEY_PATTERN.test(content)) {
      throw new RedactionValidationError('Claude/OpenAI API key detected in content; write rejected.');
    }
    if (GENERIC_TOKEN_HEX_PATTERN.test(content)) {
      throw new RedactionValidationError('Potential generic API token/hex secret detected in content; write rejected.');
    }
    if (GENERIC_TOKEN_BASE64_PATTERN.test(content)) {
      throw new RedactionValidationError('Potential generic API token/base64 secret detected in content; write rejected.');
    }
  }

  /**
   * Stores a new memory entry.
   * Performs redaction check, gates via Gatekeeper, embeds the content,
   * writes the relational row, logs the outcome, and evicts oldest items if growth exceeds limits.
   */
  async store(input: StoreMemoryInput): Promise<string> {
    const { content, sourceAgent, sourceTaskId = null, tag = '' } = input;

    // 1. Redaction check (runs BEFORE embedding/storing)
    this.checkRedaction(content);

    // 2. Permission Gatekeeper integration
    const permissionRequest = {
      actor: sourceAgent,
      action: 'memory-write',
      params: {
        tag,
        sourceTaskId,
        content: content.slice(0, 100) + (content.length > 100 ? '...' : '')
      }
    };
    const decision = await this.gatekeeper.authorize(permissionRequest);
    if (!decision.granted) {
      throw new MemoryManagerError(`Permission denied for memory-write action by actor: ${sourceAgent}`);
    }

    let embeddingId = '';
    try {
      // 3. Write Consistency Phase 1: Write Vector embedding first
      const pipelineResult = await this.embeddingPipeline.embedAndStore(content);
      embeddingId = pipelineResult.embeddingId;

      // 4. Write Consistency Phase 2: Write SQLite relational entry
      const id = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      const insertStmt = this.db.prepare(`
        INSERT INTO memory_entries (id, content, embedding_id, source_agent, source_task_id, tag, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(id, content, embeddingId, sourceAgent, sourceTaskId, tag, timestamp);

      // Record successful outcome in Audit Log
      this.auditLog.recordOutcome(
        decision.correlationId,
        sourceAgent,
        'memory-write',
        `Successfully stored memory entry with ID: ${id}`
      );

      // 5. Enforce retention limits
      this.enforceRetentionLimit();

      return id;
    } catch (error: any) {
      // Rollback orphaned vector if SQLite write failed
      if (embeddingId) {
        try {
          this.vectorStore.delete(embeddingId);
          this.logger.warn({ embeddingId }, 'Orphaned vector entry deleted due to SQLite write failure rollback.');
        } catch (cleanupError: any) {
          this.logger.error({ cleanupError }, 'Failed to clean up orphaned vector entry during rollback.');
        }
      }

      // Record failed outcome in Audit Log
      this.auditLog.recordOutcome(
        decision.correlationId,
        sourceAgent,
        'memory-write',
        `Failed to store memory entry: ${error.message}`
      );

      throw error;
    }
  }

  /**
   * Enforces the memory retention limit (FIFO oldest-eviction).
   */
  private enforceRetentionLimit(): void {
    const maxEntries = this.config.memoryMaxEntries;
    
    // Count current entries
    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM memory_entries').get() as { count: number };
    if (countRow.count <= maxEntries) {
      return;
    }

    const excessCount = countRow.count - maxEntries;
    this.logger.info({ excessCount, maxEntries }, 'Retention limit exceeded. Evicting oldest entries.');

    // Fetch oldest entries to evict
    const oldestEntries = this.db.prepare(`
      SELECT id, embedding_id FROM memory_entries
      ORDER BY timestamp ASC, id ASC
      LIMIT ?
    `).all(excessCount) as { id: string; embedding_id: string }[];

    const deleteStmt = this.db.prepare('DELETE FROM memory_entries WHERE id = ?');

    for (const entry of oldestEntries) {
      try {
        // Delete from vector store
        this.vectorStore.delete(entry.embedding_id);
        // Delete from SQLite
        deleteStmt.run(entry.id);
        this.logger.debug({ id: entry.id }, 'Evicted oldest memory entry.');
      } catch (evictError: any) {
        this.logger.error({ id: entry.id, err: evictError }, 'Error evicting oldest memory entry.');
      }
    }
  }

  /**
   * Queries memories based on query text and semantic similarity.
   * Gated via the Gatekeeper and filters results.
   */
  async query(
    text: string,
    filters?: MemoryQueryFilters,
    actorAgent = 'software-engineer'
  ): Promise<MemoryEntry[]> {
    // 1. Permission Gatekeeper integration for reads
    const permissionRequest = {
      actor: actorAgent,
      action: 'memory-read',
      params: {
        text: text.slice(0, 100) + (text.length > 100 ? '...' : ''),
        filters
      }
    };
    const decision = await this.gatekeeper.authorize(permissionRequest);
    if (!decision.granted) {
      throw new MemoryManagerError(`Permission denied for memory-read action by actor: ${actorAgent}`);
    }

    try {
      // 2. Generate embedding for query text
      const queryVec = await this.embeddingProvider.embedText(text);

      // 3. Query the vector store for semantic matches
      const limit = filters?.limit ?? 5;
      const rawVectorResults = this.vectorStore.query(queryVec, limit * 3);

      if (rawVectorResults.length === 0) {
        return [];
      }

      // 4. Resolve vector results to relational rows and apply filtering
      const resolvedEntries: MemoryEntry[] = [];
      const selectStmt = this.db.prepare('SELECT * FROM memory_entries WHERE embedding_id = ?');

      for (const res of rawVectorResults) {
        const row = selectStmt.get(res.id) as any;
        if (!row) continue;

        // Apply metadata filters
        if (filters?.tag !== undefined && row.tag !== filters.tag) {
          continue;
        }
        if (filters?.sourceAgent !== undefined && row.source_agent !== filters.sourceAgent) {
          continue;
        }

        resolvedEntries.push({
          id: row.id,
          content: row.content,
          embeddingId: row.embedding_id,
          sourceAgent: row.source_agent,
          sourceTaskId: row.source_task_id,
          tag: row.tag,
          timestamp: row.timestamp,
        });

        if (resolvedEntries.length >= limit) {
          break;
        }
      }

      return resolvedEntries;
    } catch (error: any) {
      this.logger.error({ err: error }, 'Failed to query memories.');
      throw new MemoryManagerError(`Query failed: ${error.message}`);
    }
  }

  /**
   * Direct lookup by memory_entries.id.
   * Gated via the Gatekeeper.
   */
  async getById(id: string, actorAgent = 'software-engineer'): Promise<MemoryEntry | null> {
    const permissionRequest = {
      actor: actorAgent,
      action: 'memory-read',
      params: { id }
    };
    const decision = await this.gatekeeper.authorize(permissionRequest);
    if (!decision.granted) {
      throw new MemoryManagerError(`Permission denied for memory-read action by actor: ${actorAgent}`);
    }

    try {
      const selectStmt = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?');
      const row = selectStmt.get(id) as any;
      if (!row) {
        return null;
      }

      return {
        id: row.id,
        content: row.content,
        embeddingId: row.embedding_id,
        sourceAgent: row.source_agent,
        sourceTaskId: row.source_task_id,
        tag: row.tag,
        timestamp: row.timestamp,
      };
    } catch (error: any) {
      this.logger.error({ id, err: error }, 'Failed to look up memory by ID.');
      throw new MemoryManagerError(`Lookup failed: ${error.message}`);
    }
  }
}
