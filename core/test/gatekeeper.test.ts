import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper, denyAllPrompt } from '../src/permissions/gatekeeper.js';
import { createStdinApprovalPrompt } from '../src/lib/prompt.js';
import { stdin } from 'node:process';
import { clearConfigCache } from '../src/lib/config.js';

// Setup Mock for node:readline/promises default export
const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('node:readline/promises', () => {
  return {
    default: {
      createInterface: () => ({
        question: mockQuestion,
        close: mockClose
      })
    }
  };
});

describe('PermissionGatekeeper Class', () => {
  let db: any;
  let auditLog: AuditLog;
  let logger: any;
  let origEnvApprovalTimeout: string | undefined;
  let isTTYBackup: boolean | undefined;

  beforeEach(() => {
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('test-logger', 'silent');
    origEnvApprovalTimeout = process.env.JARVIS_APPROVAL_TIMEOUT_MS;
    isTTYBackup = stdin.isTTY;
    clearConfigCache();
  });

  afterEach(() => {
    db.close();
    if (origEnvApprovalTimeout !== undefined) {
      process.env.JARVIS_APPROVAL_TIMEOUT_MS = origEnvApprovalTimeout;
    } else {
      delete process.env.JARVIS_APPROVAL_TIMEOUT_MS;
    }
    Object.defineProperty(stdin, 'isTTY', {
      value: isTTYBackup,
      configurable: true,
      writable: true,
    });
    clearConfigCache();
  });

  it('should return granted=true when approvalPrompt resolves true', async () => {
    const mockPrompt = vi.fn().mockResolvedValue(true);
    const gatekeeper = new PermissionGatekeeper(auditLog, logger, mockPrompt);

    const request = {
      actor: 'agent-alice',
      action: 'file-write' as const,
      params: { path: 'allowed.json' }
    };

    const decision = await gatekeeper.authorize(request);
    expect(decision.granted).toBe(true);
    expect(decision.correlationId).toBeDefined();

    // Verify decision exists in audit log
    const recent = auditLog.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0].correlation_id).toBe(decision.correlationId);
    expect(recent[0].approval_status).toBe('granted');
  });

  it('should return granted=false when approvalPrompt resolves false', async () => {
    const gatekeeper = new PermissionGatekeeper(auditLog, logger, denyAllPrompt);

    const request = {
      actor: 'agent-bob',
      action: 'file-delete' as const,
      params: { path: 'forbidden.json' }
    };

    const decision = await gatekeeper.authorize(request);
    expect(decision.granted).toBe(false);

    // Verify decision exists in audit log
    const recent = auditLog.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0].correlation_id).toBe(decision.correlationId);
    expect(recent[0].approval_status).toBe('denied');
  });

  it('should swallow prompt exceptions, return granted=false, and log a warning while writing the decision', async () => {
    const errorMsg = 'Interactive terminal prompt disconnected';
    const mockPrompt = vi.fn().mockRejectedValue(new Error(errorMsg));
    
    const warnSpy = vi.fn();
    const mockLogger = {
      warn: warnSpy,
      info: vi.fn()
    } as any;

    const gatekeeper = new PermissionGatekeeper(auditLog, mockLogger, mockPrompt);

    const request = {
      actor: 'agent-charlie',
      action: 'file-write' as const,
      params: { path: 'error-prone.json' }
    };

    const decision = await gatekeeper.authorize(request);
    expect(decision.granted).toBe(false);
    expect(decision.denialReason).toBe('error');

    // Prompt error handled without throwing
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    // Verify decision exists in audit log
    const recent = auditLog.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0].correlation_id).toBe(decision.correlationId);
    expect(recent[0].approval_status).toBe('denied');
  });

  it('should not invoke recordOutcome during authorize call', async () => {
    const mockPrompt = vi.fn().mockResolvedValue(true);
    const gatekeeper = new PermissionGatekeeper(auditLog, logger, mockPrompt);

    const request = {
      actor: 'agent-alice',
      action: 'file-write' as const,
      params: { path: 'outcome-test.json' }
    };

    const decision = await gatekeeper.authorize(request);
    expect(decision.granted).toBe(true);

    const recent = auditLog.recent();
    expect(recent).toHaveLength(1); // exactly one row (decision), no outcome row
    expect(recent[0].event_type).toBe('decision');
  });

  describe('Readline interactive approval prompt', () => {
    let gatekeeper: PermissionGatekeeper;

    beforeEach(() => {
      // Force TTY to be true for interactive tests
      Object.defineProperty(stdin, 'isTTY', {
        value: true,
        configurable: true,
        writable: true,
      });
      // Setup gatekeeper with the real stdin approval prompt
      const prompt = createStdinApprovalPrompt();
      gatekeeper = new PermissionGatekeeper(auditLog, logger, prompt);
    });

    it('should grant permission when user responds with "y"', async () => {
      mockQuestion.mockResolvedValue('y');

      const request = {
        actor: 'agent-bob',
        action: 'file-write' as const,
        params: { path: 'readline-allowed.json' }
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(true);
      expect(decision.denialReason).toBeUndefined();

      // Check audit log
      const recent = auditLog.recent();
      expect(recent).toHaveLength(1);
      expect(recent[0].approval_status).toBe('granted');
      expect(recent[0].params_json).toContain('readline-allowed.json');
    });

    it('should deny permission explicitly when user responds with anything else', async () => {
      mockQuestion.mockResolvedValue('n');

      const request = {
        actor: 'agent-bob',
        action: 'file-write' as const,
        params: { path: 'readline-denied.json' }
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(false);
      expect(decision.denialReason).toBe('explicit');

      // Check audit log
      const recent = auditLog.recent();
      expect(recent).toHaveLength(1);
      expect(recent[0].approval_status).toBe('denied');
    });

    it('should deny permission with timeout when user fails to respond in time', async () => {
      // Configure extremely short timeout for testing (10ms)
      process.env.JARVIS_APPROVAL_TIMEOUT_MS = '10';
      clearConfigCache();

      // Mock question to take longer (100ms)
      mockQuestion.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('y'), 100)));

      const request = {
        actor: 'agent-bob',
        action: 'file-write' as const,
        params: { path: 'readline-timeout.json' }
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(false);
      expect(decision.denialReason).toBe('timeout');

      // Check audit log
      const recent = auditLog.recent();
      expect(recent).toHaveLength(1);
      expect(recent[0].approval_status).toBe('denied');
    });
  });
});
