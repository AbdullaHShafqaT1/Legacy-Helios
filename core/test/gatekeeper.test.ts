import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper, denyAllPrompt } from '../src/permissions/gatekeeper.js';

describe('PermissionGatekeeper Class', () => {
  let db: any;
  let auditLog: AuditLog;
  let logger: any;

  beforeEach(() => {
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('test-logger', 'silent');
  });

  afterEach(() => {
    db.close();
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
});
