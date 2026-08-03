import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { createLogger } from '../src/lib/logger.js';
import { openDb } from '../src/queue/db.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { SqliteVectorStore } from '../src/memory/vectorStore.js';
import { LocalEmbeddingProvider } from '../src/memory/embeddingProvider.js';
import { EmbeddingPipeline } from '../src/memory/embeddingPipeline.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { SoftwareEngineerAgent } from '../../agents/software-engineer/SoftwareEngineerAgent.js';
import { ResearcherAgent } from '../../agents/researcher/ResearcherAgent.js';
import { ModelRouter, ModelRoute, ModelResponse } from '../src/router/modelRouter.js';

describe('Cross-Session Restart and Persistence Tests', () => {
  let tempDir: string;
  let dbPath: string;
  let vectorPath: string;
  let logger: any;
  let config: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-restart-test-'));
    dbPath = path.join(tempDir, 'main.db');
    vectorPath = path.join(tempDir, 'vectors.db');
    logger = createLogger('restart-test', 'silent');

    config = {
      dbPath,
      model: 'claude-sonnet-4-6',
      maxRetries: 3,
      pollIntervalMs: 5000,
      staleTaskTimeoutMs: 300000,
      logLevel: 'silent',
      approvalTimeoutMs: 30000,
      projectRoot: process.cwd(),
      vectorStorePath: vectorPath,
      vectorStoreType: 'sqlite-json-cosine',
      embeddingDimensions: 384,
      memoryMaxEntries: 1000,
    };
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should successfully query and retrieve direct MemoryManager entries across database close and reopen cycles', async () => {
    // --- SESSION 1: Write and close ---
    const db1 = openDb(dbPath);
    const vectorStore1 = new SqliteVectorStore(vectorPath);
    const provider1 = new LocalEmbeddingProvider(384);
    const pipeline1 = new EmbeddingPipeline(vectorStore1, provider1);
    const auditLog1 = new AuditLog(db1);
    const gatekeeper1 = new PermissionGatekeeper(auditLog1, logger, async () => true);

    const memoryManager1 = new MemoryManager(
      db1,
      vectorStore1,
      pipeline1,
      provider1,
      gatekeeper1,
      auditLog1,
      logger,
      config
    );

    const contentText = 'Prior security architecture deployment guidelines.';
    const id = await memoryManager1.store({
      content: contentText,
      sourceAgent: 'software-engineer',
      tag: 'security-auth',
    });

    expect(id).toBeDefined();

    // Close connections to simulate process termination/restart
    vectorStore1.close();
    db1.close();

    // --- SESSION 2: Reopen and read ---
    const db2 = openDb(dbPath);
    const vectorStore2 = new SqliteVectorStore(vectorPath);
    const provider2 = new LocalEmbeddingProvider(384);
    const pipeline2 = new EmbeddingPipeline(vectorStore2, provider2);
    const auditLog2 = new AuditLog(db2);
    const gatekeeper2 = new PermissionGatekeeper(auditLog2, logger, async () => true);

    const memoryManager2 = new MemoryManager(
      db2,
      vectorStore2,
      pipeline2,
      provider2,
      gatekeeper2,
      auditLog2,
      logger,
      config
    );

    // Test getById on reopened databases
    const entry = await memoryManager2.getById(id, 'researcher');
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe(contentText);
    expect(entry!.tag).toBe('security-auth');
    expect(entry!.sourceAgent).toBe('software-engineer');

    // Test query on reopened databases
    const queryResults = await memoryManager2.query('security architecture', { tag: 'security-auth' }, 'researcher');
    expect(queryResults.length).toBe(1);
    expect(queryResults[0].id).toBe(id);
    expect(queryResults[0].content).toBe(contentText);

    vectorStore2.close();
    db2.close();
  });

  it('should successfully recall context across restarts during agent-mediated processing (Software Engineer writes, restart, Researcher recalls)', async () => {
    // --- SESSION 1: Software Engineer stores memory of task completion ---
    const db1 = openDb(dbPath);
    const vectorStore1 = new SqliteVectorStore(vectorPath);
    const provider1 = new LocalEmbeddingProvider(384);
    const pipeline1 = new EmbeddingPipeline(vectorStore1, provider1);
    const auditLog1 = new AuditLog(db1);
    const gatekeeper1 = new PermissionGatekeeper(auditLog1, logger, async () => true);

    const memoryManager1 = new MemoryManager(
      db1,
      vectorStore1,
      pipeline1,
      provider1,
      gatekeeper1,
      auditLog1,
      logger,
      config
    );

    const modelRouter1 = new ModelRouter();
    modelRouter1.register({
      taskTypes: ['coding'],
      async invoke(): Promise<ModelResponse> {
        return { text: 'const serverPort = 8080;' };
      },
    });

    const swAgent = new SoftwareEngineerAgent(modelRouter1, gatekeeper1, auditLog1, memoryManager1, logger);
    const swResult = await swAgent.process({
      taskId: 'sw-task-restart',
      description: 'Configure server port #restart-project',
    });
    expect(swResult.status).toBe('completed');

    // Close connections
    vectorStore1.close();
    db1.close();

    // --- SESSION 2: Fresh start, Researcher queries memories of that project ---
    const db2 = openDb(dbPath);
    const vectorStore2 = new SqliteVectorStore(vectorPath);
    const provider2 = new LocalEmbeddingProvider(384);
    const pipeline2 = new EmbeddingPipeline(vectorStore2, provider2);
    const auditLog2 = new AuditLog(db2);
    const gatekeeper2 = new PermissionGatekeeper(auditLog2, logger, async () => true);

    const memoryManager2 = new MemoryManager(
      db2,
      vectorStore2,
      pipeline2,
      provider2,
      gatekeeper2,
      auditLog2,
      logger,
      config
    );

    const modelRouter2 = new ModelRouter();
    const routeSpy = vi.spyOn(modelRouter2, 'route').mockResolvedValue({ text: 'Research notes summary' });
    modelRouter2.register({
      taskTypes: ['research'],
      async invoke(): Promise<ModelResponse> {
        return { text: 'Research notes summary' };
      },
    });

    const resAgent = new ResearcherAgent(modelRouter2, undefined, memoryManager2, logger);
    const resResult = await resAgent.process({
      taskId: 'res-task-restart',
      description: 'Find server configuration details #restart-project',
    });

    expect(resResult.status).toBe('completed');
    expect(routeSpy).toHaveBeenCalledWith('research', expect.objectContaining({
      description: expect.stringContaining('[RECALLED PRIOR CONTEXT/MEMORIES]'),
    }));
    expect(routeSpy).toHaveBeenCalledWith('research', expect.objectContaining({
      description: expect.stringContaining('Successfully completed task: Configure server port #restart-project'),
    }));

    vectorStore2.close();
    db2.close();
  });
});
