import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { TaskQueue } from '../src/queue/index.js';
import { ModelRouter, ModelRoute, ModelRequestContext, ModelResponse } from '../src/router/modelRouter.js';
import { FilesystemConnector } from '../../connectors/filesystem/FilesystemConnector.js';
import { GitConnector } from '../../connectors/git/GitConnector.js';
import { ResearcherAgent } from '../../agents/researcher/ResearcherAgent.js';
import { SoftwareEngineerAgent } from '../../agents/software-engineer/SoftwareEngineerAgent.js';
import { toAgentInput } from '../../agents/shared/Agent.js';
import { SqliteVectorStore } from '../src/memory/vectorStore.js';
import { LocalEmbeddingProvider } from '../src/memory/embeddingProvider.js';
import { EmbeddingPipeline } from '../src/memory/embeddingPipeline.js';
import { MemoryManager } from '../src/memory/memoryManager.js';

describe('Phase 2 Cross-Agent & Researcher Integration Suite', () => {
  let tempDir: string;
  let db: any;
  let auditLog: AuditLog;
  let queue: TaskQueue;
  let logger: any;
  let mockStandardPrompt: any;
  let mockHighFrictionPrompt: any;
  let gatekeeper: PermissionGatekeeper;
  let filesystemConnector: FilesystemConnector;
  let gitConnector: GitConnector;
  let modelRouter: ModelRouter;
  let researcherAgent: ResearcherAgent;
  let softwareEngineerAgent: SoftwareEngineerAgent;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase2-int-'));
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('phase2-int-logger', 'silent');
    queue = new TaskQueue(db, logger);
    mockStandardPrompt = vi.fn().mockResolvedValue(true);
    mockHighFrictionPrompt = vi.fn().mockResolvedValue(true);

    gatekeeper = new PermissionGatekeeper(
      auditLog,
      logger,
      mockStandardPrompt,
      undefined,
      mockHighFrictionPrompt
    );

    filesystemConnector = new FilesystemConnector({
      projectRoot: tempDir,
      gatekeeper,
      auditLog,
      logger,
    });

    gitConnector = new GitConnector({
      projectRoot: tempDir,
      gatekeeper,
      auditLog,
      logger,
    });

    modelRouter = new ModelRouter();

    // Register a mock route for 'research' task type
    const researchRoute: ModelRoute = {
      taskTypes: ['research'],
      async invoke(context: ModelRequestContext): Promise<ModelResponse> {
        return {
          text: JSON.stringify({
            summary: `Research findings for: ${context.description}`,
            confidence: 'high',
            citations: ['doc.md'],
            caveats: ['No external web-fetch performed (local files only)'],
          }),
        };
      },
    };

    // Register a mock route for 'coding' task type
    const codingRoute: ModelRoute = {
      taskTypes: ['coding'],
      async invoke(context: ModelRequestContext): Promise<ModelResponse> {
        return {
          text: `// Implementation code for: ${context.description}\nconsole.log('done');`,
        };
      },
    };

    modelRouter.register(researchRoute);
    modelRouter.register(codingRoute);

    const vs = new SqliteVectorStore(':memory:');
    const prov = new LocalEmbeddingProvider(384);
    const pipe = new EmbeddingPipeline(vs, prov);
    const memoryManager = new MemoryManager(
      db,
      vs,
      pipe,
      prov,
      gatekeeper,
      auditLog,
      logger,
      {
        dbPath: ':memory:',
        model: 'claude-sonnet-4-6',
        maxRetries: 3,
        pollIntervalMs: 5000,
        staleTaskTimeoutMs: 300000,
        logLevel: 'silent',
        approvalTimeoutMs: 30000,
        projectRoot: tempDir,
        vectorStorePath: ':memory:',
        vectorStoreType: 'sqlite-json-cosine',
        embeddingDimensions: 384,
        memoryMaxEntries: 1000,
      }
    );

    researcherAgent = new ResearcherAgent(modelRouter, filesystemConnector, memoryManager, logger);
    softwareEngineerAgent = new SoftwareEngineerAgent(modelRouter, gatekeeper, auditLog, memoryManager, logger);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. should allow ResearcherAgent to submit task, read file via FilesystemConnector, return structured result, and log decision/outcome in AuditLog', async () => {
    // Create target file in workspace
    const targetFile = path.join(tempDir, 'doc.md');
    fs.writeFileSync(targetFile, '# Architecture Specification\nSystem operates with default-deny gating.');

    // Enqueue task in real TaskQueue
    const taskRow = queue.enqueue({
      description: 'Analyze system architecture specification',
      fileContext: { targetPath: 'doc.md' },
    });
    const taskId = taskRow.id;

    // Claim task from queue
    const task = queue.claimNext('researcher');
    expect(task).not.toBeNull();
    expect(task?.id).toBe(taskId);

    // Execute ResearcherAgent
    const result = await researcherAgent.process(toAgentInput(task!));

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('Research findings for:');
    expect(result.citations).toContain('doc.md');
    expect(result.confidence).toBe('high');
    expect(result.filesChanged).toHaveLength(0);

    // Mark task complete in queue
    queue.complete(taskId, JSON.stringify(result));
    const updatedTask = queue.getById(taskId);
    expect(updatedTask?.status).toBe('completed');

    // Verify AuditLog contains decision and outcome entries for 'file-read'
    const recent = auditLog.recent();
    const readDecision = recent.find((r) => r.event_type === 'decision' && r.action === 'file-read');
    const readOutcome = recent.find((r) => r.event_type === 'outcome' && r.action === 'file-read');

    expect(readDecision).toBeDefined();
    expect(readDecision?.approval_status).toBe('granted');
    expect(readDecision?.approver).toBe('policy'); // Auto-approved via policy.ts DEFAULT_AGENT_POLICIES

    expect(readOutcome).toBeDefined();
    expect(readOutcome?.outcome).toContain('success — read file');
  });

  it('2. should block researcher actor attempting file write at Gatekeeper role-based check (safety-net proof)', async () => {
    // Attempt direct write using actor 'researcher' via FilesystemConnector
    const writeResult = await filesystemConnector.writeFile(
      'researcher',
      'forbidden_notes.txt',
      'attempted research write'
    );

    expect(writeResult.success).toBe(false);
    expect(writeResult.error).toBe('permission-denied');
    expect(writeResult.explanation).toContain('not-permitted');
    expect(fs.existsSync(path.join(tempDir, 'forbidden_notes.txt'))).toBe(false);

    // Verify Gatekeeper prompt was never invoked
    expect(mockStandardPrompt).not.toHaveBeenCalled();

    // Verify AuditLog reflects system denial for researcher role
    const recent = auditLog.recent();
    const writeDecision = recent.find((r) => r.event_type === 'decision' && r.action === 'file-write');
    const writeOutcome = recent.find((r) => r.event_type === 'outcome' && r.action === 'file-write');

    expect(writeDecision).toBeDefined();
    expect(writeDecision?.approval_status).toBe('denied');
    expect(writeDecision?.approver).toBe('system');

    expect(writeOutcome).toBeDefined();
    expect(writeOutcome?.outcome).toBe('denied — not-permitted');
  });

  it('2b. should never invoke writeFile or deleteFile on FilesystemConnector during normal ResearcherAgent.process() execution', async () => {
    const writeFileSpy = vi.spyOn(filesystemConnector, 'writeFile');
    const deleteFileSpy = vi.spyOn(filesystemConnector, 'deleteFile');
    const readFileSpy = vi.spyOn(filesystemConnector, 'readFile');

    fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'data to read');

    const result = await researcherAgent.process({
      taskId: 'test-2b',
      description: 'Check read-only guarantee',
      fileContext: { targetPath: 'sample.txt' },
    });

    expect(result.status).toBe('completed');
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(deleteFileSpy).not.toHaveBeenCalled();
  });

  it('3. should deterministically order same-millisecond task insertions across mixed agent types in TaskQueue via sequence_id', async () => {
    // Freeze time so created_at is identical down to the millisecond for all tasks
    vi.useFakeTimers();
    const fixedNow = new Date('2026-07-27T12:00:00.000Z');
    vi.setSystemTime(fixedNow);

    const id1 = queue.enqueue({ description: 'Software engineer task A', priority: 1 }).id;
    const id2 = queue.enqueue({ description: 'Researcher task A', priority: 1 }).id;
    const id3 = queue.enqueue({ description: 'Software engineer task B', priority: 1 }).id;
    const id4 = queue.enqueue({ description: 'Researcher task B', priority: 1 }).id;

    const allTasks = queue.listAll();
    expect(allTasks).toHaveLength(4);

    // Verify all tasks share identical created_at timestamp
    expect(allTasks[0].created_at).toBe(allTasks[1].created_at);
    expect(allTasks[1].created_at).toBe(allTasks[2].created_at);

    // Verify sequence_id enforces deterministic increasing FIFO ordering
    const sortedBySeq = [...allTasks].sort((a, b) => a.sequence_id - b.sequence_id);
    expect(sortedBySeq[0].id).toBe(id1);
    expect(sortedBySeq[1].id).toBe(id2);
    expect(sortedBySeq[2].id).toBe(id3);
    expect(sortedBySeq[3].id).toBe(id4);

    // Verify claimNext pulls in deterministic FIFO order regardless of agent type
    const claim1 = queue.claimNext('software-engineer');
    expect(claim1?.id).toBe(id1);

    const claim2 = queue.claimNext('researcher');
    expect(claim2?.id).toBe(id2);

    const claim3 = queue.claimNext('software-engineer');
    expect(claim3?.id).toBe(id3);

    const claim4 = queue.claimNext('researcher');
    expect(claim4?.id).toBe(id4);

    vi.useRealTimers();
  });

  it('4. should engage high-friction confirmation for destructive Git operation (resetHard) and reject when plain "y" is provided', async () => {
    // Initialize a real Git repository in tempDir
    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Integration Test User'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'int-test@example.com'], { cwd: tempDir });

    const f1 = path.join(tempDir, 'state1.txt');
    fs.writeFileSync(f1, 'state 1');
    await gitConnector.commit('software-engineer', 'First commit');
    const firstCommit = (await gitConnector.log('software-engineer', 1)).commits![0].hash;

    const f2 = path.join(tempDir, 'state2.txt');
    fs.writeFileSync(f2, 'state 2');
    await gitConnector.commit('software-engineer', 'Second commit');

    // Simulate high-friction prompt receiving "y" instead of "CONFIRM REWRITE HISTORY" -> returns false
    mockHighFrictionPrompt.mockResolvedValue(false);

    const resetResult = await gitConnector.resetHard('software-engineer', firstCommit);

    expect(resetResult.success).toBe(false);
    expect(resetResult.error).toBe('permission-denied');

    // Verify it called the highFrictionPrompt via Gatekeeper routing
    expect(mockHighFrictionPrompt).toHaveBeenCalledTimes(1);

    // Verify working tree was NOT rewritten
    expect(fs.existsSync(f2)).toBe(true);

    // Verify AuditLog recorded denial of high-friction action 'git-history-rewrite'
    const recent = auditLog.recent();
    const rewriteDecision = recent.find((r) => r.action === 'git-history-rewrite' && r.event_type === 'decision');
    const rewriteOutcome = recent.find((r) => r.action === 'git-history-rewrite' && r.event_type === 'outcome');

    expect(rewriteDecision).toBeDefined();
    expect(rewriteDecision?.approval_status).toBe('denied');
    expect(rewriteOutcome).toBeDefined();
    expect(rewriteOutcome?.outcome).toContain('denied');
  });
});
