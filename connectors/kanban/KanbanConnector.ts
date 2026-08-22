import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';

export interface KanbanCard {
  id: string;
  columnId: string;
  taskId: string | null;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanColumn {
  id: string;
  boardId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanBoard {
  id: string;
  name: string;
  /** Null = global / not workspace-scoped (backward-compat with pre-Phase-12 boards). */
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class KanbanConnector {
  private db: Database.Database;
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private logger: Logger;
  private defaultBoardId: string;
  private defaultBoardName: string;

  constructor(
    db: Database.Database,
    gatekeeper: PermissionGatekeeper,
    auditLog: AuditLog,
    logger: Logger,
    defaultBoardId = 'default-board',
    defaultBoardName = 'Default Board',
    private readonly defaultWorkspaceId: string | null = null
  ) {
    this.db = db;
    this.gatekeeper = gatekeeper;
    this.auditLog = auditLog;
    this.logger = logger;
    this.defaultBoardId = defaultBoardId;
    this.defaultBoardName = defaultBoardName;
  }

  private async authorizeWrite(actor: string, operation: string, params: Record<string, any>): Promise<string> {
    const request = {
      actor: actor as any,
      action: 'kanban-write',
      params: {
        operation,
        ...params
      }
    };

    const decision = await this.gatekeeper.authorize(request);

    if (!decision.granted) {
      const outcome = decision.denialReason === 'timeout'
        ? 'denied — timeout'
        : 'denied — not-permitted';

      this.auditLog.recordOutcome(decision.correlationId, actor, 'kanban-write', outcome);
      throw new Error(`Kanban write operation "${operation}" denied: ${outcome}`);
    }

    return decision.correlationId;
  }

  private resolveColumnId(colId: string, boardId: string): string {
    const colSlug = colId.toLowerCase().replace(' ', '-');
    if (['todo', 'in-progress', 'review', 'done'].includes(colSlug)) {
      return `${boardId}-${colSlug}`;
    }
    if (colId.startsWith(`${boardId}-`)) {
      return colId;
    }
    return `${boardId}-${colId}`;
  }

  async initDefaultBoard(actor: string, boardId = this.defaultBoardId, name = this.defaultBoardName, workspaceId: string | null = this.defaultWorkspaceId): Promise<void> {
    const existing = this.db.prepare('SELECT id FROM kanban_boards WHERE id = ?').get(boardId);
    if (existing) return;

    const correlationId = await this.authorizeWrite(actor, 'initDefaultBoard', { boardId, name });
    const now = new Date().toISOString();

    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO kanban_boards (id, name, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        `).run(boardId, name, workspaceId ?? null, now, now);

        const columns = ['Todo', 'In Progress', 'Review', 'Done'];
        columns.forEach((colName, index) => {
          const colSlug = colName.toLowerCase().replace(' ', '-');
          this.db.prepare(`
            INSERT INTO kanban_columns (id, board_id, name, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(`${boardId}-${colSlug}`, boardId, colName, index, now, now);
        });
      })();

      this.auditLog.recordOutcome(correlationId, actor, 'kanban-write', `success — initialized board ${boardId}`);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.auditLog.recordOutcome(correlationId, actor, 'kanban-write', `error — ${errMsg}`);
      throw err;
    }
  }

  async createCard(
    actor: string,
    params: { id: string; columnId: string; taskId?: string; title: string; status: string }
  ): Promise<void> {
    const correlationId = await this.authorizeWrite(actor, 'createCard', params);
    const now = new Date().toISOString();
    const resolvedColId = this.resolveColumnId(params.columnId, this.defaultBoardId);

    try {
      this.db.prepare(`
        INSERT INTO kanban_cards (id, column_id, task_id, title, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(params.id, resolvedColId, params.taskId ?? null, params.title, params.status, now, now);

      this.auditLog.recordOutcome(
        correlationId,
        actor,
        'kanban-write',
        `success — created card "${params.title}" in column ${resolvedColId}`
      );
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.auditLog.recordOutcome(correlationId, actor, 'kanban-write', `error — ${errMsg}`);
      throw err;
    }
  }

  async moveCard(
    actor: string,
    params: { cardId: string; columnId: string; status: string }
  ): Promise<void> {
    const correlationId = await this.authorizeWrite(actor, 'moveCard', params);
    const now = new Date().toISOString();
    const resolvedColId = this.resolveColumnId(params.columnId, this.defaultBoardId);

    try {
      const stmt = this.db.prepare(`
        UPDATE kanban_cards
        SET column_id = ?, status = ?, updated_at = ?
        WHERE id = ?
      `);
      const result = stmt.run(resolvedColId, params.status, now, params.cardId);

      if (result.changes === 0) {
        throw new Error(`Kanban card with ID "${params.cardId}" not found.`);
      }

      this.auditLog.recordOutcome(
        correlationId,
        actor,
        'kanban-write',
        `success — moved card ${params.cardId} to column ${resolvedColId}`
      );
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.auditLog.recordOutcome(correlationId, actor, 'kanban-write', `error — ${errMsg}`);
      throw err;
    }
  }

  getCards(boardId = this.defaultBoardId): KanbanCard[] {
    const stmt = this.db.prepare(`
      SELECT c.*
      FROM kanban_cards c
      JOIN kanban_columns col ON c.column_id = col.id
      WHERE col.board_id = ?
      ORDER BY col.position ASC, c.created_at ASC
    `);

    const rows = stmt.all(boardId) as any[];
    return rows.map(r => ({
      id: r.id,
      columnId: r.column_id,
      taskId: r.task_id,
      title: r.title,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  getCardByTaskId(taskId: string): KanbanCard | undefined {
    const stmt = this.db.prepare('SELECT * FROM kanban_cards WHERE task_id = ?');
    const r = stmt.get(taskId) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      columnId: r.column_id,
      taskId: r.task_id,
      title: r.title,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  getBoardStatus(boardId = this.defaultBoardId): string {
    const board = this.db.prepare('SELECT name FROM kanban_boards WHERE id = ?').get(boardId) as { name: string } | undefined;
    if (!board) return 'No board found.';

    const cards = this.getCards(boardId);
    const columns = this.db.prepare('SELECT * FROM kanban_columns WHERE board_id = ? ORDER BY position ASC').all(boardId) as any[];

    let report = `Kanban Board: ${board.name}\n`;
    columns.forEach(col => {
      const colCards = cards.filter(c => c.columnId === col.id);
      report += `[${col.name}] (${colCards.length} cards)\n`;
      colCards.forEach(card => {
        report += `  - ${card.title} (Task: ${card.taskId ?? 'N/A'}, Status: ${card.status})\n`;
      });
    });

    return report;
  }

  /**
   * Returns all boards associated with a specific workspace.
   */
  getBoardsForWorkspace(workspaceId: string): KanbanBoard[] {
    const rows = this.db
      .prepare('SELECT id, name, workspace_id, created_at, updated_at FROM kanban_boards WHERE workspace_id = ? ORDER BY created_at ASC')
      .all(workspaceId) as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      workspaceId: r.workspace_id ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
