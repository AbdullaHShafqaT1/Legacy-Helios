import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../src/queue/db.js';
import { AuditLog } from '../src/permissions/auditLog.js';

describe('AuditLog Class', () => {
  let db: any;
  let auditLog: AuditLog;

  beforeEach(() => {
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should insert exactly one decision row and return a correlation ID', () => {
    const correlationId = auditLog.recordDecision({
      actor: 'test-actor',
      action: 'file-write',
      params: { path: 'test.txt' },
      approvalStatus: 'granted',
      approver: 'system'
    });

    expect(correlationId).toBeDefined();
    expect(typeof correlationId).toBe('string');
    expect(correlationId.length).toBeGreaterThan(0);

    const rows = auditLog.recent();
    expect(rows).toHaveLength(1);
    expect(rows[0].correlation_id).toBe(correlationId);
    expect(rows[0].event_type).toBe('decision');
    expect(rows[0].actor).toBe('test-actor');
    expect(rows[0].action).toBe('file-write');
    expect(rows[0].approval_status).toBe('granted');
    expect(rows[0].approver).toBe('system');
    expect(rows[0].outcome).toBeNull();
  });

  it('should insert exactly one outcome row using the same correlation ID', () => {
    const correlationId = 'test-corr-123';
    auditLog.recordOutcome(correlationId, 'test-actor', 'file-write', 'Success: 120 bytes written');

    const rows = auditLog.recent();
    expect(rows).toHaveLength(1);
    expect(rows[0].correlation_id).toBe(correlationId);
    expect(rows[0].event_type).toBe('outcome');
    expect(rows[0].actor).toBe('test-actor');
    expect(rows[0].action).toBe('file-write');
    expect(rows[0].approval_status).toBe('n-a');
    expect(rows[0].approver).toBeNull();
    expect(rows[0].params_json).toBeNull();
    expect(rows[0].outcome).toBe('Success: 120 bytes written');
  });

  it('should redact params passed to recordDecision before writing to the database', () => {
    const correlationId = auditLog.recordDecision({
      actor: 'test-actor',
      action: 'file-write',
      params: { path: 'test.txt', apiKey: 'sk-ant-leakkey', token: 'secret-token', safeField: 'all-clear' },
      approvalStatus: 'granted',
      approver: 'system'
    });

    const rows = auditLog.recent();
    expect(rows).toHaveLength(1);
    
    const paramsJsonStr = rows[0].params_json;
    expect(paramsJsonStr).toBeDefined();
    
    const parsedParams = JSON.parse(paramsJsonStr!);
    expect(parsedParams.apiKey).toBe('[REDACTED]');
    expect(parsedParams.token).toBe('[REDACTED]');
    expect(parsedParams.safeField).toBe('all-clear');
    
    expect(paramsJsonStr).not.toContain('sk-ant-leakkey');
    expect(paramsJsonStr).not.toContain('secret-token');
  });

  it('should return recent rows newest-first and respect the limit argument', () => {
    // Write 3 records
    const c1 = auditLog.recordDecision({ actor: 'a1', action: 'write', approvalStatus: 'granted', approver: 'user' });
    const c2 = auditLog.recordDecision({ actor: 'a2', action: 'delete', approvalStatus: 'denied', approver: 'user' });
    auditLog.recordOutcome(c1, 'a1', 'write', 'Done');

    // recent() should return newest first: outcome for c1 (id 3), decision c2 (id 2), decision c1 (id 1)
    const allRows = auditLog.recent();
    expect(allRows).toHaveLength(3);
    expect(allRows[0].event_type).toBe('outcome');
    expect(allRows[0].correlation_id).toBe(c1);
    expect(allRows[1].event_type).toBe('decision');
    expect(allRows[1].correlation_id).toBe(c2);
    expect(allRows[2].event_type).toBe('decision');
    expect(allRows[2].correlation_id).toBe(c1);

    // Limit check
    const limitedRows = auditLog.recent(2);
    expect(limitedRows).toHaveLength(2);
    expect(limitedRows[0].event_type).toBe('outcome');
    expect(limitedRows[1].event_type).toBe('decision');
  });
});
