import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { redactSecrets } from '../lib/redact.js';

export interface AuditLogRow {
  id: number;
  correlation_id: string;
  event_type: 'decision' | 'outcome';
  timestamp: string;
  actor: string;
  action: string;
  params_json: string | null;
  approval_status: 'granted' | 'denied' | 'n-a';
  approver: string | null;
  outcome: string | null;
}

export class AuditLog {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Records a permission request decision in the audit log.
   *
   * @param input Detailed decision parameters.
   * @returns A generated unique correlation ID linking this decision with its eventual outcome.
   */
  recordDecision(input: {
    actor: string;
    action: string;
    params?: unknown;
    approvalStatus: 'granted' | 'denied' | 'n-a';
    approver: 'system' | 'user' | 'policy';
  }): string {
    const correlationId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    // Apply recursive secrets redaction before stringifying
    const redactedParams = redactSecrets(input.params ?? null);
    const paramsJson = JSON.stringify(redactedParams);

    const insertStmt = this.db.prepare(`
      INSERT INTO audit_log (
        correlation_id, event_type, timestamp, actor, action, params_json, approval_status, approver, outcome
      ) VALUES (?, 'decision', ?, ?, ?, ?, ?, ?, NULL)
    `);

    insertStmt.run(
      correlationId,
      now,
      input.actor,
      input.action,
      paramsJson,
      input.approvalStatus,
      input.approver
    );

    return correlationId;
  }

  /**
   * Records the outcome of an action in the audit log.
   *
   * @param correlationId The correlation ID returned by the initial decision entry.
   * @param actor The actor that executed the action.
   * @param action The action that was executed.
   * @param outcome Descriptive text outcome of the action execution.
   */
  recordOutcome(
    correlationId: string,
    actor: string,
    action: string,
    outcome: string
  ): void {
    const now = new Date().toISOString();

    const insertStmt = this.db.prepare(`
      INSERT INTO audit_log (
        correlation_id, event_type, timestamp, actor, action, params_json, approval_status, approver, outcome
      ) VALUES (?, 'outcome', ?, ?, ?, NULL, 'n-a', NULL, ?)
    `);

    insertStmt.run(
      correlationId,
      now,
      actor,
      action,
      outcome
    );
  }

  /**
   * Fetches recent audit log entries, ordered newest first.
   *
   * @param limit Maximum number of records to retrieve (default: 50).
   * @returns An array of AuditLogRow objects.
   */
  recent(limit = 50): AuditLogRow[] {
    return this.db.prepare(`
      SELECT * FROM audit_log
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as AuditLogRow[];
  }

  /**
   * Records a pending approval request for the Unattended Approval Queue.
   */
  recordPendingApproval(correlationId: string, taskId: string, payload: unknown): void {
    const now = new Date().toISOString();
    const payloadStr = JSON.stringify(payload);
    const insertStmt = this.db.prepare(`
      INSERT INTO pending_approvals (id, correlation_id, task_id, request_payload_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `);
    insertStmt.run(crypto.randomUUID(), correlationId, taskId, payloadStr, now, now);
  }

  /**
   * Gets the status of a pending approval for a given task and payload.
   */
  getPendingApprovalStatus(taskId: string, payload: unknown): 'pending' | 'granted' | 'denied' | null {
    const payloadStr = JSON.stringify(payload);
    const row = this.db.prepare(`
      SELECT status FROM pending_approvals
      WHERE task_id = ? AND request_payload_json = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(taskId, payloadStr) as { status: string } | undefined;
    
    return (row?.status as 'pending' | 'granted' | 'denied') || null;
  }
}
