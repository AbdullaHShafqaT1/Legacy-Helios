import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { ModelRouter, ModelRoute, ModelRequestContext, ModelResponse } from '../src/router/modelRouter.js';

describe('Agent Memory Integration Tests', () => {
  let db: Database.Database;
  let vectorStore: SqliteVectorStore;
  let provider: LocalEmbeddingProvider;
  let pipeline: EmbeddingPipeline;
  let auditLog: AuditLog;
  let gatekeeper: PermissionGatekeeper;
  let logger: any;
  let config: any;
  let memoryManager: MemoryManager;
  let modelRouter: ModelRouter;
  let mockCodingText: string;
  let mockResearchText: string;

  beforeEach(() => {
    db = openDb(':memory:');
    vectorStore = new SqliteVectorStore(':memory:');
    provider = new LocalEmbeddingProvider(384);
    pipeline = new EmbeddingPipeline(vectorStore, provider);
    auditLog = new AuditLog(db);
    logger = createLogger('agent-memory-int-test', 'silent');

    gatekeeper = new PermissionGatekeeper(
      auditLog,
      logger,
      async () => true
    );

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
      memoryMaxEntries: 1000,
    };

    memoryManager = new MemoryManager(
      db,
      vectorStore,
      pipeline,
      provider,
      gatekeeper,
      auditLog,
      logger,
      config
    );

    modelRouter = new ModelRouter();
    mockCodingText = 'const code = 123;';
    mockResearchText = 'Research result notes';

    const codingRoute: ModelRoute = {
      taskTypes: ['coding'],
      async invoke(): Promise<ModelResponse> {
        return { text: mockCodingText };
      },
    };

    const researchRoute: ModelRoute = {
      taskTypes: ['research'],
      async invoke(): Promise<ModelResponse> {
        return { text: JSON.stringify({ summary: mockResearchText, confidence: 'high' }) };
      },
    };

    modelRouter.register(codingRoute);
    modelRouter.register(researchRoute);
  });

  afterEach(() => {
    vectorStore.close();
    db.close();
  });

  it('should process task normally when no prior memory exists for its project/tag (recall returns empty)', async () => {
    const swAgent = new SoftwareEngineerAgent(modelRouter, gatekeeper, auditLog, memoryManager, logger);
    const result = await swAgent.process({
      taskId: 'task-1',
      description: 'Write simple module #newproject',
    });

    expect(result.status).toBe('completed');
    expect(result.explanation).toBe(mockCodingText);

    // Verify memory was indeed stored for this project
    const memories = await memoryManager.query('simple module', { tag: 'newproject' }, 'software-engineer');
    expect(memories.length).toBe(1);
    expect(memories[0].content).toContain('Successfully completed task: Write simple module #newproject');
  });

  it('should recall context during processing and write completions to memory for both agents', async () => {
    const swAgent = new SoftwareEngineerAgent(modelRouter, gatekeeper, auditLog, memoryManager, logger);
    const resAgent = new ResearcherAgent(modelRouter, undefined, memoryManager, logger);

    const querySpy = vi.spyOn(memoryManager, 'query');
    const storeSpy = vi.spyOn(memoryManager, 'store');

    // 1. Software Engineer processes a task
    const swResult = await swAgent.process({
      taskId: 'sw-task-1',
      description: 'Write code under [project: my-project]',
    });
    expect(swResult.status).toBe('completed');
    expect(querySpy).toHaveBeenCalledWith('Write code under [project: my-project]', { tag: 'my-project', limit: 5 }, 'software-engineer');
    expect(storeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sourceAgent: 'software-engineer',
      tag: 'my-project',
      sourceTaskId: 'sw-task-1',
    }));

    // Reset spies
    querySpy.mockClear();
    storeSpy.mockClear();

    // 2. Researcher processes a task under same project
    const resResult = await resAgent.process({
      taskId: 'res-task-1',
      description: 'Research guidelines under [project: my-project]',
    });
    expect(resResult.status).toBe('completed');
    expect(querySpy).toHaveBeenCalledWith('Research guidelines under [project: my-project]', { tag: 'my-project', limit: 5 }, 'researcher');
    expect(storeSpy).toHaveBeenCalledWith(expect.objectContaining({
      sourceAgent: 'researcher',
      tag: 'my-project',
      sourceTaskId: 'res-task-1',
    }));
  });

  it('should share memories across agents by project tag (Software Engineer retrieves Researcher memory, and vice versa)', async () => {
    const swAgent = new SoftwareEngineerAgent(modelRouter, gatekeeper, auditLog, memoryManager, logger);
    const resAgent = new ResearcherAgent(modelRouter, undefined, memoryManager, logger);

    const routeSpy = vi.spyOn(modelRouter, 'route');

    // --- DIRECTION A: Software Engineer writes memory -> Researcher retrieves it ---
    
    // Software Engineer runs task, completed status stores a memory
    const swResult = await swAgent.process({
      taskId: 'sw-task-2',
      description: 'Implement database connection logic #shared-project',
    });
    expect(swResult.status).toBe('completed');

    // Researcher runs task under the same project tag
    const resResult = await resAgent.process({
      taskId: 'res-task-2',
      description: 'Find performance bugs in database logic #shared-project',
    });
    expect(resResult.status).toBe('completed');

    // Verify the model routing description for Researcher received Software Engineer's memory
    expect(routeSpy).toHaveBeenLastCalledWith('research', expect.objectContaining({
      description: expect.stringContaining('[RECALLED PRIOR CONTEXT/MEMORIES]'),
    }));
    expect(routeSpy).toHaveBeenLastCalledWith('research', expect.objectContaining({
      description: expect.stringContaining('Successfully completed task: Implement database connection logic #shared-project'),
    }));

    // Clear router spy calls
    routeSpy.mockClear();

    // --- DIRECTION B: Researcher writes memory -> Software Engineer retrieves it ---

    // Researcher completes task, storing a memory
    mockResearchText = 'We found connection pooling is missing.';
    const resResult2 = await resAgent.process({
      taskId: 'res-task-3',
      description: 'Find optimal DB pool size #shared-project',
    });
    expect(resResult2.status).toBe('completed');

    // Software Engineer runs task under same tag
    const swResult2 = await swAgent.process({
      taskId: 'sw-task-3',
      description: 'Configure pool size #shared-project',
    });
    expect(swResult2.status).toBe('completed');

    // Verify the model routing description for Software Engineer received Researcher's memory
    expect(routeSpy).toHaveBeenLastCalledWith('coding', expect.objectContaining({
      description: expect.stringContaining('[RECALLED PRIOR CONTEXT/MEMORIES]'),
    }));
    expect(routeSpy).toHaveBeenLastCalledWith('coding', expect.objectContaining({
      description: expect.stringContaining('We found connection pooling is missing.'),
    }));
  });

  it('should handle memory-store redaction validation errors gracefully without crashing the agent task execution', async () => {
    const swAgent = new SoftwareEngineerAgent(modelRouter, gatekeeper, auditLog, memoryManager, logger);

    // Force the model output to contain an obvious API key
    mockCodingText = 'My secret key is sk-proj-12345abcde12345abcde12345abcde';

    // Verify task still completes and doesn't crash/throw
    const result = await swAgent.process({
      taskId: 'task-redact-surfaces',
      description: 'Output secret file #project-secrets',
    });

    expect(result.status).toBe('completed');
    expect(result.explanation).toBe(mockCodingText);

    // Verify no memory was written to the DB due to redaction rejection
    const memories = await memoryManager.query('secret file', { tag: 'project-secrets' }, 'software-engineer');
    expect(memories).toEqual([]);
  });
});
