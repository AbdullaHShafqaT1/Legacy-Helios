import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createLogger } from '../src/lib/logger.js';
import { openDb } from '../src/queue/db.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { SqliteVectorStore } from '../src/memory/vectorStore.js';
import { LocalEmbeddingProvider } from '../src/memory/embeddingProvider.js';
import { EmbeddingPipeline } from '../src/memory/embeddingPipeline.js';
import {
  MemoryManager,
  MemoryManagerError,
  RedactionValidationError,
} from '../src/memory/memoryManager.js';
import { Config } from '../src/lib/config.js';

describe('MemoryManager', () => {
  let db: Database.Database;
  let vectorStore: SqliteVectorStore;
  let provider: LocalEmbeddingProvider;
  let pipeline: EmbeddingPipeline;
  let auditLog: AuditLog;
  let gatekeeper: PermissionGatekeeper;
  let logger: any;
  let config: Config;
  let manager: MemoryManager;

  beforeEach(() => {
    db = openDb(':memory:');
    vectorStore = new SqliteVectorStore(':memory:');
    provider = new LocalEmbeddingProvider(384);
    pipeline = new EmbeddingPipeline(vectorStore, provider);
    auditLog = new AuditLog(db);
    logger = createLogger('memory-manager-test', 'silent');

    // Create a mock gatekeeper that grants permission by default
    gatekeeper = new PermissionGatekeeper(
      auditLog,
      logger,
      async () => true
    );

    // Mock config with max entries limit set to 3 to easily test retention/eviction
    config = {
      dbPath: ':memory:',
      model: 'claude-sonnet-4-6',
      maxRetries: 3,
      pollIntervalMs: 5000,
      staleTaskTimeoutMs: 300000,
      logLevel: 'silent',
      approvalTimeoutMs: 30000,
      projectRoot: process.cwd(),
      vectorStorePath: ':memory:',
      vectorStoreType: 'sqlite-json-cosine',
      embeddingDimensions: 384,
      memoryMaxEntries: 3,
    };

    manager = new MemoryManager(
      db,
      vectorStore,
      pipeline,
      provider,
      gatekeeper,
      auditLog,
      logger,
      config
    );
  });

  afterEach(() => {
    vectorStore.close();
    db.close();
  });

  it('should return a clean empty result when queried against an empty/newly-initialized store', async () => {
    const results = await manager.query('arbitrary test search query');
    expect(results).toEqual([]);
  });

  it('should store and retrieve memories via store, getById, and query (happy path)', async () => {
    const content = 'Legitimate software engineering task detailing database migrations.';
    const id = await manager.store({
      content,
      sourceAgent: 'software-engineer',
      tag: 'database',
      sourceTaskId: 'task-101',
    });

    expect(id).toBeTypeOf('string');
    expect(id.length).toBeGreaterThan(0);

    // 1. Test getById
    const retrieved = await manager.getById(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(id);
    expect(retrieved!.content).toBe(content);
    expect(retrieved!.sourceAgent).toBe('software-engineer');
    expect(retrieved!.tag).toBe('database');
    expect(retrieved!.sourceTaskId).toBe('task-101');
    expect(retrieved!.timestamp).toBeTypeOf('string');
    expect(retrieved!.embeddingId).toBeTypeOf('string');

    // 2. Test semantic query
    const queryResults = await manager.query('database migrations query');
    expect(queryResults.length).toBe(1);
    expect(queryResults[0].id).toBe(id);
    expect(queryResults[0].content).toBe(content);

    // 3. Test filtering with matching filters
    const matchedFiltered = await manager.query('database migrations', {
      tag: 'database',
      sourceAgent: 'software-engineer',
    });
    expect(matchedFiltered.length).toBe(1);

    // 4. Test filtering with non-matching filters
    const mismatchedTag = await manager.query('database migrations', {
      tag: 'frontend',
    });
    expect(mismatchedTag).toEqual([]);

    const mismatchedAgent = await manager.query('database migrations', {
      sourceAgent: 'researcher',
    });
    expect(mismatchedAgent).toEqual([]);
  });

  it('should trigger redaction validation and reject storing obvious secrets', async () => {
    const originalCount = vectorStore.count();

    // Test AWS secret Key pattern
    await expect(
      manager.store({
        content: 'This has AWS secret keys like AKIA1234567890ABCDEF',
        sourceAgent: 'software-engineer',
      })
    ).rejects.toThrow(RedactionValidationError);

    // Test Claude/OpenAI API Key pattern
    await expect(
      manager.store({
        content: 'Here is my OpenAI key sk-proj-12345abcde12345abcde12345abcde',
        sourceAgent: 'software-engineer',
      })
    ).rejects.toThrow(RedactionValidationError);

    // Test generic long hex pattern (potential api keys/hashes)
    await expect(
      manager.store({
        content: 'sensitive token a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        sourceAgent: 'software-engineer',
      })
    ).rejects.toThrow(RedactionValidationError);

    // Verify nothing got stored in vectorStore
    expect(vectorStore.count()).toBe(originalCount);
  });

  it('should enforce FIFO oldest-eviction retention growth-bounding strategy', async () => {
    // Fill up to max entries (3)
    const id1 = await manager.store({ content: 'Memory entry one', sourceAgent: 'software-engineer', tag: 'tag1' });
    const id2 = await manager.store({ content: 'Memory entry two', sourceAgent: 'software-engineer', tag: 'tag2' });
    const id3 = await manager.store({ content: 'Memory entry three', sourceAgent: 'software-engineer', tag: 'tag3' });

    expect(vectorStore.count()).toBe(3);

    // Inspect database rows
    const countRowBefore = db.prepare('SELECT COUNT(*) as cnt FROM memory_entries').get() as { cnt: number };
    expect(countRowBefore.cnt).toBe(3);

    // Store fourth entry, triggering eviction of oldest (id1)
    const id4 = await manager.store({ content: 'Memory entry four', sourceAgent: 'software-engineer', tag: 'tag4' });

    // Count should still be capped at 3
    const countRowAfter = db.prepare('SELECT COUNT(*) as cnt FROM memory_entries').get() as { cnt: number };
    expect(countRowAfter.cnt).toBe(3);
    expect(vectorStore.count()).toBe(3);

    // Check id1 is evicted
    const getEvicted = await manager.getById(id1);
    expect(getEvicted).toBeNull();

    // Check id2, id3, id4 still exist
    expect(await manager.getById(id2)).not.toBeNull();
    expect(await manager.getById(id3)).not.toBeNull();
    expect(await manager.getById(id4)).not.toBeNull();
  });

  it('should handle partial-write failures by rolling back/deleting orphaned vector store entries', async () => {
    const originalVectorCount = vectorStore.count();

    // Spy/Intercept db.prepare to throw error on Relational DB inserts
    const originalPrepare = db.prepare;
    db.prepare = function (sql: string) {
      if (sql.includes('INSERT INTO memory_entries')) {
        return {
          run: () => {
            throw new Error('Simulated SQLite DB insert failure');
          },
        } as any;
      }
      return originalPrepare.call(db, sql);
    };

    // Store memory call should fail
    await expect(
      manager.store({
        content: 'Should rollback successfully',
        sourceAgent: 'software-engineer',
      })
    ).rejects.toThrow('Simulated SQLite DB insert failure');

    // Vector store count should remain exactly unchanged (rolled back)
    expect(vectorStore.count()).toBe(originalVectorCount);

    // Restore original db.prepare
    db.prepare = originalPrepare;
  });

  it('should gate memory writes via PermissionGatekeeper and throw error on rejection', async () => {
    // Set up gatekeeper to always deny
    vi.spyOn(gatekeeper, 'authorize').mockResolvedValue({
      granted: false,
      correlationId: 'test-deny-id',
      denialReason: 'explicit',
      approver: 'user',
    });

    await expect(
      manager.store({
        content: 'This write should fail gatekeeper gating',
        sourceAgent: 'software-engineer',
      })
    ).rejects.toThrow(MemoryManagerError);

    // Verify database remains empty
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM memory_entries').get() as { cnt: number };
    expect(countRow.cnt).toBe(0);
    expect(vectorStore.count()).toBe(0);
  });

  it('should log redaction-triggered rejections in the Audit Log', async () => {
    await expect(
      manager.store({
        content: 'sensitive openai key sk-proj-abcdef1234567890abcdef1234567890',
        sourceAgent: 'software-engineer',
        tag: 'secrets-test',
        sourceTaskId: 'task-redact-log',
      })
    ).rejects.toThrow(RedactionValidationError);

    // Retrieve the newly added logs (one decision, one outcome)
    const logs = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 2').all() as any[];
    expect(logs.length).toBe(2);

    const outcomeLog = logs[0];
    const decisionLog = logs[1];

    expect(decisionLog.event_type).toBe('decision');
    expect(decisionLog.action).toBe('memory-write');
    expect(decisionLog.approval_status).toBe('denied');
    expect(decisionLog.approver).toBe('system');
    expect(decisionLog.params_json).toContain('[REDACTED - SENSITIVE CONTENT]');
    expect(decisionLog.params_json).not.toContain('sk-proj-');

    expect(outcomeLog.event_type).toBe('outcome');
    expect(outcomeLog.action).toBe('memory-write');
    expect(outcomeLog.outcome).toContain('Rejected due to detected secret pattern: Claude/OpenAI API key');
  });

  it('should handle reverse partial-write failures where vector store write fails first', async () => {
    // Mock vectorStore.store to fail
    vi.spyOn(vectorStore, 'store').mockImplementation(() => {
      throw new Error('Simulated Vector Store storage failure');
    });

    await expect(
      manager.store({
        content: 'This memory write should fail during vector store phase',
        sourceAgent: 'software-engineer',
      })
    ).rejects.toThrow(/Simulated Vector Store storage failure/);

    // Verify no memory_entries row was created
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM memory_entries').get() as { cnt: number };
    expect(countRow.cnt).toBe(0);
  });
});
