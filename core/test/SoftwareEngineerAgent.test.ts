import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SoftwareEngineerAgent } from '../../agents/software-engineer/SoftwareEngineerAgent.js';
import { ModelRouter, ModelRouterError } from '../src/router/modelRouter.js';
import { createLogger } from '../src/lib/logger.js';

describe('SoftwareEngineerAgent', () => {
  let tempDir: string;
  let logger: any;
  let mockModelRouter: any;
  let mockGatekeeper: any;
  let mockAuditLog: any;
  let agent: SoftwareEngineerAgent;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
    logger = createLogger('agent-test-logger', 'silent');

    mockModelRouter = {
      route: vi.fn()
    };

    mockGatekeeper = {
      authorize: vi.fn()
    };

    mockAuditLog = {
      recordDecision: vi.fn(),
      recordOutcome: vi.fn(),
      recent: vi.fn()
    };

    agent = new SoftwareEngineerAgent(
      mockModelRouter as any,
      mockGatekeeper as any,
      mockAuditLog as any,
      logger
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should complete task without filesystem calls when targetPath is absent', async () => {
    mockModelRouter.route.mockResolvedValue({ text: 'Model text output' });

    const result = await agent.process({
      taskId: 'task-1',
      description: 'Generate dummy config file',
      fileContext: { unrelatedField: 'some-value' }
    });

    expect(result.status).toBe('completed');
    expect(result.filesChanged).toEqual([]);
    expect(result.explanation).toBe('Model text output');
    expect(result.error).toBeUndefined();

    expect(mockGatekeeper.authorize).not.toHaveBeenCalled();
    expect(mockAuditLog.recordOutcome).not.toHaveBeenCalled();
  });

  it('should return failure status when gatekeeper denies write permission', async () => {
    mockModelRouter.route.mockResolvedValue({ text: 'Denied model content' });
    mockGatekeeper.authorize.mockResolvedValue({ granted: false, correlationId: 'corr-deny-123' });

    const testFilePath = path.join(tempDir, 'denied_file.txt');

    const result = await agent.process({
      taskId: 'task-2',
      description: 'Write file content',
      fileContext: { targetPath: testFilePath }
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('permission-denied');
    expect(result.filesChanged).toEqual([]);
    expect(result.explanation).toContain('was denied by the gatekeeper');

    // Confirm no file was written
    expect(fs.existsSync(testFilePath)).toBe(false);

    // Confirm auditLog.recordOutcome was called once with a string containing "denied"
    expect(mockAuditLog.recordOutcome).toHaveBeenCalledTimes(1);
    expect(mockAuditLog.recordOutcome).toHaveBeenCalledWith(
      'corr-deny-123',
      'software-engineer',
      'file-write',
      expect.stringContaining('denied')
    );
  });

  it('should write file to disk when gatekeeper grants permission', async () => {
    mockModelRouter.route.mockResolvedValue({ text: 'Grated model code text' });
    mockGatekeeper.authorize.mockResolvedValue({ granted: true, correlationId: 'corr-grant-456' });

    const testFilePath = path.join(tempDir, 'granted_file.txt');

    const result = await agent.process({
      taskId: 'task-3',
      description: 'Write granted file',
      fileContext: { targetPath: testFilePath }
    });

    expect(result.status).toBe('completed');
    expect(result.filesChanged).toEqual([testFilePath]);
    expect(result.error).toBeUndefined();

    // Confirm file was written and matches model output
    expect(fs.existsSync(testFilePath)).toBe(true);
    expect(fs.readFileSync(testFilePath, 'utf8')).toBe('Grated model code text');

    // Confirm auditLog.recordOutcome was called once with a string containing "success"
    expect(mockAuditLog.recordOutcome).toHaveBeenCalledTimes(1);
    expect(mockAuditLog.recordOutcome).toHaveBeenCalledWith(
      'corr-grant-456',
      'software-engineer',
      'file-write',
      expect.stringContaining('success')
    );
  });

  it('should recursively create parent directories if they do not exist', async () => {
    mockModelRouter.route.mockResolvedValue({ text: 'Nested folder file text' });
    mockGatekeeper.authorize.mockResolvedValue({ granted: true, correlationId: 'corr-grant-789' });

    const testFilePath = path.join(tempDir, 'nested', 'folders', 'deep_file.txt');

    const result = await agent.process({
      taskId: 'task-4',
      description: 'Write nested file',
      fileContext: { targetPath: testFilePath }
    });

    expect(result.status).toBe('completed');
    expect(result.filesChanged).toEqual([testFilePath]);

    // Confirm folder exists and file written successfully
    expect(fs.existsSync(testFilePath)).toBe(true);
    expect(fs.readFileSync(testFilePath, 'utf8')).toBe('Nested folder file text');
  });

  it('should propagate model routing errors out of the process method', async () => {
    const routeError = new ModelRouterError('Failed to route coding request');
    mockModelRouter.route.mockRejectedValue(routeError);

    await expect(
      agent.process({
        taskId: 'task-5',
        description: 'Failing route task',
        fileContext: { targetPath: 'failing.txt' }
      })
    ).rejects.toThrow(ModelRouterError);

    expect(mockGatekeeper.authorize).not.toHaveBeenCalled();
    expect(mockAuditLog.recordOutcome).not.toHaveBeenCalled();
  });

  it('should return failure status and log denied — timeout when gatekeeper times out', async () => {
    mockModelRouter.route.mockResolvedValue({ text: 'Timeout model content' });
    mockGatekeeper.authorize.mockResolvedValue({
      granted: false,
      correlationId: 'corr-timeout-123',
      denialReason: 'timeout'
    });

    const testFilePath = path.join(tempDir, 'timeout_file.txt');

    const result = await agent.process({
      taskId: 'task-timeout',
      description: 'Write file content with timeout',
      fileContext: { targetPath: testFilePath }
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('permission-denied');
    expect(result.filesChanged).toEqual([]);

    // Confirm no file was written
    expect(fs.existsSync(testFilePath)).toBe(false);

    // Confirm auditLog.recordOutcome was called once with "denied — timeout"
    expect(mockAuditLog.recordOutcome).toHaveBeenCalledTimes(1);
    expect(mockAuditLog.recordOutcome).toHaveBeenCalledWith(
      'corr-timeout-123',
      'software-engineer',
      'file-write',
      'denied — timeout'
    );
  });
});
