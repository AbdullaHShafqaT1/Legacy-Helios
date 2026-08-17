import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { openDb } from '../src/queue/db.js';
import { TaskQueue } from '../src/queue/index.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper, denyAllPrompt } from '../src/permissions/gatekeeper.js';
import { executionContext } from '../src/lib/context.js';
import fs from 'node:fs';

describe('Phase 7 Integration: Voice Security Boundary', () => {
  let db: Database.Database;
  let queue: TaskQueue;
  let auditLog: AuditLog;
  let gatekeeper: PermissionGatekeeper;
  let logger: pino.Logger;

  beforeEach(() => {
    db = openDb(':memory:');
    logger = pino({ level: 'silent' });
    auditLog = new AuditLog(db);
    queue = new TaskQueue(db, logger);
    
    // Use denyAllPrompt for interactive. If it tries to prompt interactively, it will deny.
    // If it routes to unattended queue, it will return pending-approval.
    gatekeeper = new PermissionGatekeeper(auditLog, logger, denyAllPrompt);
  });

  afterEach(() => {
    db.close();
  });

  it('voice-originated tasks cannot bypass Gatekeeper and require CLI approval', async () => {
    // 1. Submit task from voice
    const task = queue.enqueue({
      description: 'Open browser and click submit',
      source: 'voice',
    });

    expect(task.source).toBe('voice');

    // 2. Simulate agent trying to execute a browser-write action within the task context
    const permissionReq = {
      actor: 'browser-operator' as const,
      action: 'browser-write',
      params: { url: 'https://example.com' },
    };

    let decision = await executionContext.run({ taskId: task.id }, async () => {
      // By default, config.unattended might be false. However, gatekeeper should force 
      // unattended mode because task.source === 'voice'
      return await gatekeeper.authorize(permissionReq);
    });

    // 3. Verify it was thrown to pending-approval (Unattended Queue) and NOT auto-approved or interactively prompted (which would be denied by denyAllPrompt)
    expect(decision.granted).toBe(false);
    expect(decision.denialReason).toBe('pending-approval');

    // 4. Verify Audit Log reflects the pending state
    const logs1 = auditLog.recent(10);
    const decisionLog = logs1.find(l => l.event_type === 'decision' && l.correlation_id === decision.correlationId);
    expect(decisionLog).toBeDefined();
    expect(decisionLog?.approval_status).toBe('pending');

    // 5. CLI user explicitly approves the request
    const pendingStatus = auditLog.getPendingApprovalStatus(task.id, { ...permissionReq, action: 'browser-write' });
    expect(pendingStatus).toBe('pending');

    db.prepare(`
      UPDATE pending_approvals 
      SET status = 'granted', updated_at = ?
      WHERE task_id = ? AND status = 'pending'
    `).run(new Date().toISOString(), task.id);

    // 6. Agent retries authorization (like it does in unattended resume loop)
    decision = await executionContext.run({ taskId: task.id }, async () => {
      return await gatekeeper.authorize(permissionReq);
    });

    // 7. Verify the request is now granted
    expect(decision.granted).toBe(true);

    const logs2 = auditLog.recent(10);
    const newDecisionLog = logs2.find(l => l.event_type === 'decision' && l.correlation_id === decision.correlationId);
    expect(newDecisionLog).toBeDefined();
    expect(newDecisionLog?.approval_status).toBe('granted');
    expect(newDecisionLog?.approver).toBe('user');
  });
});
