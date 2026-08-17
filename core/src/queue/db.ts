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
      sequence_id INTEGER,
      FOREIGN KEY (depends_on) REFERENCES tasks (id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_sequence_id ON tasks (sequence_id);

    CREATE TRIGGER IF NOT EXISTS trg_tasks_sequence_id
    AFTER INSERT ON tasks
    FOR EACH ROW
    WHEN NEW.sequence_id IS NULL
    BEGIN
      UPDATE tasks
      SET sequence_id = (SELECT COALESCE(MAX(sequence_id), 0) + 1 FROM tasks)
      WHERE id = NEW.id;
    END;

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('request', 'decision', 'outcome')),
      timestamp TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      params_json TEXT,
      approval_status TEXT NOT NULL CHECK (approval_status IN ('pending', 'granted', 'denied', 'n-a')),
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

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding_id TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      source_task_id TEXT,
      tag TEXT DEFAULT '',
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding_id ON memory_entries (embedding_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_source_agent ON memory_entries (source_agent);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_tag ON memory_entries (tag);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_timestamp ON memory_entries (timestamp);

    CREATE TABLE IF NOT EXISTS kanban_boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kanban_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (board_id) REFERENCES kanban_boards (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      task_id TEXT UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (column_id) REFERENCES kanban_columns (id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kanban_columns_board_id ON kanban_columns (board_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_column_id ON kanban_cards (column_id);
    CREATE INDEX IF NOT EXISTS idx_kanban_cards_task_id ON kanban_cards (task_id);
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      schedule_expression TEXT NOT NULL,
      missed_run_policy TEXT NOT NULL CHECK (missed_run_policy IN ('skip', 'catch-up')),
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run_at ON scheduled_tasks (next_run_at);

    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      request_payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'denied')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pending_approvals_task_id ON pending_approvals (task_id);
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals (status);
  `;

  // Run migration check if table 'tasks' already exists before executing schemaDdl
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  if (tableExists) {
    const tableInfo = db.pragma('table_info(tasks)') as { name: string }[];
    const hasSequenceColumn = tableInfo.some(col => col.name === 'sequence_id');
    if (!hasSequenceColumn) {
      db.exec('ALTER TABLE tasks ADD COLUMN sequence_id INTEGER');
      // Backfill sequence_id sequentially based on insertion order (rowid)
      db.exec(`
        UPDATE tasks
        SET sequence_id = (
          SELECT COUNT(*)
          FROM tasks t2
          WHERE t2.rowid <= tasks.rowid
        )
        WHERE sequence_id IS NULL
      `);
    }
  }

  // Audit Log Migration for Phase 6 Unattended 4-state transitions
  const auditLogTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
  if (auditLogTableExists) {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE name='audit_log'").get() as { sql: string };
    if (tableInfo && !tableInfo.sql.includes("'request'")) {
      db.exec('PRAGMA foreign_keys=OFF;');
      db.exec('DROP TRIGGER IF EXISTS trg_audit_log_prevent_update');
      db.exec('DROP TRIGGER IF EXISTS trg_audit_log_prevent_delete');
      db.exec('ALTER TABLE audit_log RENAME TO audit_log_old');
      db.exec(schemaDdl);
      db.exec('INSERT INTO audit_log SELECT * FROM audit_log_old');
      db.exec('DROP TABLE audit_log_old');
      db.exec('PRAGMA foreign_keys=ON;');
    }
  }

  db.exec(schemaDdl);

  return db;
}
