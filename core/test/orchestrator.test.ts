import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/queue/db.js';
import { TaskQueue } from '../src/queue/index.js';
import { AgentRouter } from '../src/router/agentRouter.js';
import { JarvisEventBus } from '../src/events/bus.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createLogger } from '../src/lib/logger.js';
import { Agent } from '../../agents/shared/Agent.js';

describe('Orchestrator Class', () => {
  let tempDir: string;
  let db: any;
  let queue: TaskQueue;
  let agentRouter: AgentRouter;
  let eventBus: JarvisEventBus;
  let logger: any;
  let orchestrator: Orchestrator;
  let mockAgentProcess: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-orch-test-'));
    db = openDb(':memory:');
    logger = createLogger('test-orch-logger', 'silent');
    queue = new TaskQueue(db, createLogger('test-q', 'silent'));
    agentRouter = new AgentRouter();
    eventBus = new JarvisEventBus();

    mockAgentProcess = vi.fn();
    const fakeAgent: Agent = {
      name: 'fake-agent',
      process: mockAgentProcess
    };
    agentRouter.register(fakeAgent, { isDefault: true });

    orchestrator = new Orchestrator(queue, agentRouter, eventBus, logger, {
      pollIntervalMs: 20,
      staleTaskTimeoutMs: 10000,
      stopSignalPath: path.join(tempDir, 'EMERGENCY_STOP')
    });
  });

  afterEach(() => {
    orchestrator.stop();
    db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should process a pending task and mark it completed when the agent succeeds', async () => {
    mockAgentProcess.mockResolvedValue({
      status: 'completed',
      filesChanged: [],
      explanation: 'Succeeded processing'
    });

    const task = queue.enqueue({ description: 'Successful task task' });
    expect(task.status).toBe('pending');

    orchestrator.start();

    // Allow a few poll cycles to run
    await new Promise(resolve => setTimeout(resolve, 80));

    const checkTask = queue.getById(task.id);
    expect(checkTask?.status).toBe('completed');
    expect(mockAgentProcess).toHaveBeenCalledTimes(1);
  });

  it('should reschedule or fail the task when the agent returns failed status', async () => {
    mockAgentProcess.mockResolvedValue({
      status: 'failed',
      filesChanged: [],
      explanation: 'Failed processing',
      error: 'process-error'
    });

    // Enqueue with maxRetries = 1 (meaning it tries initial + 1 retry = 2 total attempts)
    const task = queue.enqueue({ description: 'Failing status task', maxRetries: 1 });

    orchestrator.start();

    // Wait for the first attempt and first retry execution to run
    await new Promise(resolve => setTimeout(resolve, 150));

    const checkTask = queue.getById(task.id);
    expect(checkTask?.status).toBe('failed');
    expect(checkTask?.retries).toBe(2);
    expect(checkTask?.error).toBe('process-error');
  });

  it('should fail task when the agent throws an exception', async () => {
    mockAgentProcess.mockRejectedValue(new Error('Internal agent crash'));

    const task = queue.enqueue({ description: 'Throwing task', maxRetries: 0 });

    orchestrator.start();

    await new Promise(resolve => setTimeout(resolve, 80));

    const checkTask = queue.getById(task.id);
    expect(checkTask?.status).toBe('failed');
    expect(checkTask?.error).toBe('Internal agent crash');
  });

  it('should halt claiming new tasks when stopped is called', async () => {
    mockAgentProcess.mockResolvedValue({
      status: 'completed',
      filesChanged: [],
      explanation: 'Success'
    });

    orchestrator.start();
    orchestrator.stop(); // Stop immediately

    const task = queue.enqueue({ description: 'Task after stop' });

    // Wait a couple of poll cycles
    await new Promise(resolve => setTimeout(resolve, 80));

    const checkTask = queue.getById(task.id);
    expect(checkTask?.status).toBe('pending'); // Never claimed
    expect(mockAgentProcess).not.toHaveBeenCalled();
  });

  it('should stop claiming new tasks when the stop signal file is created', async () => {
    mockAgentProcess.mockResolvedValue({
      status: 'completed',
      filesChanged: [],
      explanation: 'Success'
    });

    orchestrator.start();

    // Create the EMERGENCY_STOP signal file
    fs.writeFileSync(path.join(tempDir, 'EMERGENCY_STOP'), '');

    const task = queue.enqueue({ description: 'Task after signal file created' });

    // Wait a couple of cycles
    await new Promise(resolve => setTimeout(resolve, 80));

    const checkTask = queue.getById(task.id);
    expect(checkTask?.status).toBe('pending'); // Never claimed
    expect(mockAgentProcess).not.toHaveBeenCalled();
  });
});
