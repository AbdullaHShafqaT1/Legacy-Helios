import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/queue/db.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper, denyAllPrompt } from '../src/permissions/gatekeeper.js';
import { createLogger } from '../src/lib/logger.js';
import fs from 'node:fs';
import { executionContext } from '../src/lib/context.js';
import * as configModule from '../src/lib/config.js';

const logger = createLogger('test', 'silent');

describe('Unattended Approval Queue logic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle unattended approval flow correctly', async () => {
    const dbPath = 'memory-store/unattended-test.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const db = openDb(dbPath);
    const auditLog = new AuditLog(db);

    // Mock loadConfig to return unattended = true
    vi.spyOn(configModule, 'loadConfig').mockReturnValue({
      unattended: true,
      logLevel: 'silent',
      dbPath,
      projectRoot: '/tmp',
    } as any);

    // Insert dummy task to satisfy foreign key
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO tasks (id, description, status, priority, retries, max_retries, created_at, updated_at, sequence_id)
      VALUES ('test-unattended', 'test', 'pending', 0, 0, 3, ?, ?, 1)
    `).run(now, now);

  const gatekeeper = new PermissionGatekeeper(auditLog, logger, denyAllPrompt);

    await executionContext.run({ taskId: 'test-unattended' }, async () => {
      // 1. Initial request should be denied and queued for pending approval
      const result1 = await gatekeeper.authorize({
        actor: 'software-engineer',
        action: 'file-write',
        params: { path: '/tmp/test.txt' },
      });
      
      expect(result1.granted).toBe(false);
      expect(result1.denialReason).toBe('pending-approval');

      // 2. Approve the request via DB
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE pending_approvals 
        SET status = 'granted', updated_at = ?
        WHERE task_id = ? AND status = 'pending'
      `).run(now, 'test-unattended');

      // 3. Next request should be auto-approved
      const result2 = await gatekeeper.authorize({
        actor: 'software-engineer',
        action: 'file-write',
        params: { path: '/tmp/test.txt' },
      });

      expect(result2.granted).toBe(true);
      expect(result2.approver).toBe('user');
    });

    db.close();
    fs.unlinkSync(dbPath);
  });
});
