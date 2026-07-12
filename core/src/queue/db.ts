import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Opens a database connection to the SQLite database at the specified path.
 * Initializes the schema, enabling foreign keys, and configures WAL mode for file-based databases.
 *
 * @param dbPath The path to the SQLite database file, or ':memory:' for an in-memory database.
 * @returns An initialized better-sqlite3 Database instance.
 */
export function openDb(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    const parentDir = path.dirname(dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new Database(dbPath);

  // Enable foreign keys constraints for all connections
  db.pragma('foreign_keys = ON');

  // Enable WAL (Write-Ahead Logging) mode only for real file-based databases.
  // better-sqlite3 will throw if WAL mode is set on an in-memory database.
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  // Define the schema
  //
  // DESIGN DECISION: Audit Log Immutability (Decision/Outcome pattern)
  //
  // To meet strict security and auditability requirements, the audit log must be provably
  // append-only. Conventional designs sometimes create a single row for an action and then
  // update that row when the action completes (e.g. adding result or status updates).
  //
  // However, permitting UPDATE statements on the table presents a security risk, as it allows
  // historical data to be mutated. To enforce absolute immutability, we configure BEFORE UPDATE
  // and BEFORE DELETE triggers that throw an abort error, entirely blocking mutations at the DB level.
  //
  // Because UPDATEs are blocked, we model actions as two separate, immutable events:
  // 1. A 'decision' event, written BEFORE the action executes.
  // 2. An 'outcome' event, written AFTER the action completes.
  // Both rows are linked together via a unique 'correlation_id'. This achieves full execution
  // traceability using purely INSERT operations.
  const schemaDdl = `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      file_context TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in-progress', 'completed', 'failed', 'blocked')),
      priority INTEGER NOT NULL DEFAULT 0,
      depends_on TEXT,
      retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      error TEXT,
      result_json TEXT,
      locked_by TEXT,
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (depends_on) REFERENCES tasks (id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (priority);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('decision', 'outcome')),
      timestamp TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      params_json TEXT,
      approval_status TEXT NOT NULL CHECK (approval_status IN ('granted', 'denied', 'n-a')),
      approver TEXT,
      outcome TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_correlation_id ON audit_log (correlation_id);

    CREATE TRIGGER IF NOT EXISTS trg_audit_log_prevent_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'Audit log entries are immutable and cannot be updated.');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_log_prevent_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'Audit log entries are immutable and cannot be deleted.');
    END;
  `;

  db.exec(schemaDdl);

  return db;
}
