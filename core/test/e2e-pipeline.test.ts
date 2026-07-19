import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/queue/db.js';
import { TaskQueue } from '../src/queue/index.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { ModelRouter } from '../src/router/modelRouter.js';
import { ClaudeConnector } from '../../connectors/claude-api/ClaudeConnector.js';
import { AgentRouter } from '../src/router/agentRouter.js';
import { SoftwareEngineerAgent } from '../../agents/software-engineer/SoftwareEngineerAgent.js';
import { JarvisEventBus } from '../src/events/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createLogger } from '../src/lib/logger.js';
import { clearConfigCache } from '../src/lib/config.js';

// Setup Mock for Anthropic SDK calls
const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class Anthropic {
      messages = {
        create: mockMessagesCreate,
      };
    },
  };
});

describe('Jarvis E2E Pipeline Integration Tests', () => {
  let tempDir: string;
  let dbPath: string;
  let stopSignalPath: string;
  let db: any;
  let queue: TaskQueue;
  let auditLog: AuditLog;
  let gatekeeper: PermissionGatekeeper;
  let modelRouter: ModelRouter;
  let agentRouter: AgentRouter;
  let eventBus: JarvisEventBus;
  let orchestrator: Orchestrator;
  let logger: any;

  const approvalPromptMock = vi.fn();

  beforeEach(() => {
    clearConfigCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-test-'));
    dbPath = path.join(tempDir, 'jarvis.db');
    stopSignalPath = path.join(tempDir, 'EMERGENCY_STOP');

    // Setup real logger (silent for testing)
    logger = createLogger('e2e-logger', 'silent');

    // Instantiate real database on file-backed SQLite database
    db = openDb(dbPath);
    queue = new TaskQueue(db, logger);
    auditLog = new AuditLog(db);

    // Setup gatekeeper with dynamic mock prompt
    gatekeeper = new PermissionGatekeeper(auditLog, logger, approvalPromptMock);

    // Setup Model Router & Claude Connector
    modelRouter = new ModelRouter();
    const connector = new ClaudeConnector({
      apiKey: 'dummy-key',
      model: 'claude-sonnet-4-6',
      maxRetries: 0,
      logger,
    });
    modelRouter.register(connector);

    // Setup Agent Router & Software Engineer Agent
    agentRouter = new AgentRouter();
    const softwareEngineer = new SoftwareEngineerAgent(modelRouter, gatekeeper, auditLog, logger);
    agentRouter.register(softwareEngineer, { isDefault: true });

    // Setup Event Bus
    eventBus = new JarvisEventBus();

    // Setup Orchestrator
    orchestrator = new Orchestrator(queue, agentRouter, eventBus, logger, {
      pollIntervalMs: 30,
      staleTaskTimeoutMs: 10000,
      stopSignalPath,
    });
  });

  afterEach(() => {
    orchestrator.stop();
    if (db) {
      db.close();
    }
    clearConfigCache();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should process a task with no targetPath successfully', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello, this is a targetPath-less response.' }],
    });

    const task = queue.enqueue({
      description: 'Run basic calculation',
    });

    orchestrator.start();

    // Wait a couple of poll cycles
    await new Promise(resolve => setTimeout(resolve, 100));

    const updatedTask = queue.getById(task.id);
    expect(updatedTask?.status).toBe('completed');
    expect(updatedTask?.result_json).toContain('Hello, this is a targetPath-less response.');

    orchestrator.stop();
  });

  it('should complete task, write target file, and audit decision/outcome when approval is granted', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'This text should be written to file.' }],
    });
    approvalPromptMock.mockResolvedValue(true);

    const targetPath = path.join(tempDir, 'granted_output.txt');
    const task = queue.enqueue({
      description: 'Generate standard file write task',
      fileContext: { targetPath },
    });

    orchestrator.start();

    await new Promise(resolve => setTimeout(resolve, 120));

    const updatedTask = queue.getById(task.id);
    expect(updatedTask?.status).toBe('completed');

    // Assert the file actually exists and contains the exact response content
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('This text should be written to file.');

    // Assert direct AuditLog decision & outcomes
    const logs = auditLog.recent();
    const decisionRow = logs.find(r => r.event_type === 'decision' && r.action === 'file-write');
    const outcomeRow = logs.find(r => r.event_type === 'outcome' && r.action === 'file-write');

    expect(decisionRow).toBeDefined();
    expect(decisionRow?.approval_status).toBe('granted');
    expect(decisionRow?.actor).toBe('software-engineer');

    expect(outcomeRow).toBeDefined();
    expect(outcomeRow?.correlation_id).toBe(decisionRow?.correlation_id);
    expect(outcomeRow?.outcome).toContain('success');

    orchestrator.stop();
  });

  it('should fail task with permission-denied, write no file, and audit denial when approval is rejected', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Secret code block' }],
    });
    approvalPromptMock.mockResolvedValue(false);

    const targetPath = path.join(tempDir, 'denied_output.txt');
    const task = queue.enqueue({
      description: 'Write restricted script file',
      fileContext: { targetPath },
      maxRetries: 0,
    });

    orchestrator.start();

    await new Promise(resolve => setTimeout(resolve, 120));

    const updatedTask = queue.getById(task.id);
    expect(updatedTask?.status).toBe('failed');
    expect(updatedTask?.error).toBe('permission-denied');

    // Assert the file does NOT exist on disk
    expect(fs.existsSync(targetPath)).toBe(false);

    // Assert direct AuditLog decision & outcomes
    const logs = auditLog.recent();
    const decisionRow = logs.find(r => r.event_type === 'decision' && r.action === 'file-write');
    const outcomeRow = logs.find(r => r.event_type === 'outcome' && r.action === 'file-write');

    expect(decisionRow).toBeDefined();
    expect(decisionRow?.approval_status).toBe('denied');

    expect(outcomeRow).toBeDefined();
    expect(outcomeRow?.correlation_id).toBe(decisionRow?.correlation_id);
    expect(outcomeRow?.outcome).toContain('denied');

    orchestrator.stop();
  });

  it('should fail task A and cascade block task B which depends on task A', async () => {
    // Force Claude API calls to throw, exhausting connector retries
    mockMessagesCreate.mockRejectedValue(new Error('Rate limit exceeded'));

    const taskA = queue.enqueue({
      description: 'Task A (API dependent)',
      maxRetries: 1, // retry once (total 2 attempts) to run faster
    });

    const taskB = queue.enqueue({
      description: 'Task B (Dependent on A)',
      dependsOn: taskA.id,
    });

    orchestrator.start();

    // Wait long enough for Task A to fail attempts and Task B to be resolved as blocked
    await new Promise(resolve => setTimeout(resolve, 250));

    const updatedA = queue.getById(taskA.id);
    const updatedB = queue.getById(taskB.id);

    expect(updatedA?.status).toBe('failed');
    expect(updatedB?.status).toBe('blocked');
    expect(updatedB?.error).toContain(taskA.id);

    orchestrator.stop();
  });

  it('should emergency stop when stop-signal file is written to stopSignalPath', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Should not run' }],
    });

    // Write stop signal file simulating CLI stop command
    fs.writeFileSync(stopSignalPath, new Date().toISOString(), 'utf8');

    const task = queue.enqueue({
      description: 'Task enqueued after emergency stop',
    });

    orchestrator.start();

    // Wait a couple of poll cycles
    await new Promise(resolve => setTimeout(resolve, 100));

    const updatedTask = queue.getById(task.id);
    expect(updatedTask?.status).toBe('pending'); // Task remains pending since stop signal halts claims

    orchestrator.stop();
  });
});
