import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/queue/db.js';

describe('Database connection and schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Open in-memory database for testing
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should successfully open an in-memory database without throwing WAL pragma errors', () => {
    expect(db.open).toBe(true);
    expect(db.memory).toBe(true);
  });

  it('should create tables, indexes, and triggers successfully', () => {
    // Query sqlite_master to verify tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('audit_log');

    // Query sqlite_master to verify indexes exist
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_tasks_status');
    expect(indexNames).toContain('idx_tasks_priority');
    expect(indexNames).toContain('idx_audit_log_correlation_id');

    // Query sqlite_master to verify triggers exist
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
    const triggerNames = triggers.map(t => t.name);
    expect(triggerNames).toContain('trg_audit_log_prevent_update');
    expect(triggerNames).toContain('trg_audit_log_prevent_delete');
  });

  it('should allow inserting valid task rows and reject invalid statuses', () => {
    const insertStmt = db.prepare(`
      INSERT INTO tasks (id, description, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Valid statuses: 'pending', 'in-progress', 'completed', 'failed', 'blocked'
    expect(() => insertStmt.run('task-1', 'Test task 1', 'pending', 0, '2026-07-10T12:00:00Z', '2026-07-10T12:00:00Z')).not.toThrow();
    expect(() => insertStmt.run('task-2', 'Test task 2', 'in-progress', 1, '2026-07-10T12:00:00Z', '2026-07-10T12:00:00Z')).not.toThrow();

    // Invalid status: 'bogus'
    expect(() => insertStmt.run('task-3', 'Test task 3', 'bogus', 0, '2026-07-10T12:00:00Z', '2026-07-10T12:00:00Z')).toThrow(/CHECK constraint failed/);
  });

  it('should allow inserting valid audit_log rows and reject invalid event_types or approval_statuses', () => {
    const insertStmt = db.prepare(`
      INSERT INTO audit_log (correlation_id, event_type, timestamp, actor, action, approval_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Valid insertions
    expect(() => insertStmt.run('corr-123', 'decision', '2026-07-10T12:00:00Z', 'agent-1', 'write_file', 'granted')).not.toThrow();
    expect(() => insertStmt.run('corr-123', 'outcome', '2026-07-10T12:01:00Z', 'agent-1', 'write_file', 'n-a')).not.toThrow();

    // Invalid event_type: 'invalid-type'
    expect(() => insertStmt.run('corr-124', 'invalid-type', '2026-07-10T12:00:00Z', 'agent-1', 'write_file', 'granted')).toThrow(/CHECK constraint failed/);

    // Invalid approval_status: 'approved'
    expect(() => insertStmt.run('corr-125', 'decision', '2026-07-10T12:00:00Z', 'agent-1', 'write_file', 'approved')).toThrow(/CHECK constraint failed/);
  });

  it('should throw an error and prevent UPDATE on audit_log table due to trigger', () => {
    db.prepare(`
      INSERT INTO audit_log (correlation_id, event_type, timestamp, actor, action, approval_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('corr-999', 'decision', '2026-07-10T12:00:00Z', 'agent-1', 'write_file', 'granted');

    const updateStmt = db.prepare("UPDATE audit_log SET actor = 'malicious-agent' WHERE correlation_id = 'corr-999'");
    expect(() => updateStmt.run()).toThrow(/Audit log entries are immutable and cannot be updated/);
  });

  it('should throw an error and prevent DELETE on audit_log table due to trigger', () => {
    db.prepare(`
      INSERT INTO audit_log (correlation_id, event_type, timestamp, actor, action, approval_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('corr-999', 'decision', '2026-07-10T12:00:00Z', 'agent-1', 'write_file', 'granted');

    const deleteStmt = db.prepare("DELETE FROM audit_log WHERE correlation_id = 'corr-999'");
    expect(() => deleteStmt.run()).toThrow(/Audit log entries are immutable and cannot be deleted/);
  });
});
