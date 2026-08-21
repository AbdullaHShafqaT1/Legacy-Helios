import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Logger } from 'pino';

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
    Object.setPrototypeOf(this, WorkspaceError.prototype);
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(name: string) {
    super(`Workspace "${name}" does not exist.`);
    this.name = 'WorkspaceNotFoundError';
    Object.setPrototypeOf(this, WorkspaceNotFoundError.prototype);
  }
}

/**
 * WorkspaceManager controls the registry of named project workspaces.
 *
 * Design decisions:
 * - Workspace root paths are stored as resolved absolute paths.
 * - Each workspace retains Phase 2's path-traversal boundary: the
 *   resolved root is the scoping anchor for FilesystemConnector instances.
 * - `active_workspace` is a single-row sentinel table (id = 1). NULL
 *   means "no workspace active; use config.projectRoot as fallback."
 * - Mid-task switch: the active-workspace pointer is updated immediately,
 *   but any in-flight task already holds its own workspace context and
 *   completes in that original context. Subsequently submitted tasks pick
 *   up the new workspace.
 * - Remove with queued tasks: blocked by default; caller must pass
 *   `force: true` to orphan those tasks (sets their workspace_id = null).
 */
export class WorkspaceManager {
  private db: Database.Database;
  private logger: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Creates a new named workspace anchored at the given root path.
   * The path must already exist on disk.
   */
  createWorkspace(name: string, rootPath: string): Workspace {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new WorkspaceError('Workspace name must not be empty.');
    }

    const resolvedRoot = path.resolve(rootPath.trim());
    if (!fs.existsSync(resolvedRoot)) {
      throw new WorkspaceError(
        `Root path "${resolvedRoot}" does not exist on disk. Create the directory before registering it as a workspace.`
      );
    }
    const stat = fs.statSync(resolvedRoot);
    if (!stat.isDirectory()) {
      throw new WorkspaceError(`Root path "${resolvedRoot}" is not a directory.`);
    }

    const existing = this.db
      .prepare('SELECT id FROM workspaces WHERE name = ?')
      .get(trimmedName);
    if (existing) {
      throw new WorkspaceError(`A workspace named "${trimmedName}" already exists.`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO workspaces (id, name, root_path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, trimmedName, resolvedRoot, now);

    this.logger.info({ workspaceId: id, name: trimmedName, rootPath: resolvedRoot }, 'Workspace created.');
    return { id, name: trimmedName, rootPath: resolvedRoot, createdAt: now };
  }

  /**
   * Returns all registered workspaces.
   */
  listWorkspaces(): Workspace[] {
    const rows = this.db.prepare('SELECT id, name, root_path, created_at FROM workspaces ORDER BY created_at ASC').all() as any[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      rootPath: r.root_path,
      createdAt: r.created_at,
    }));
  }

  /**
   * Returns a single workspace by name, or null if not found.
   */
  getWorkspaceByName(name: string): Workspace | null {
    const r = this.db.prepare('SELECT id, name, root_path, created_at FROM workspaces WHERE name = ?').get(name.trim()) as any;
    if (!r) return null;
    return { id: r.id, name: r.name, rootPath: r.root_path, createdAt: r.created_at };
  }

  /**
   * Returns a single workspace by id, or null if not found.
   */
  getWorkspaceById(id: string): Workspace | null {
    const r = this.db.prepare('SELECT id, name, root_path, created_at FROM workspaces WHERE id = ?').get(id) as any;
    if (!r) return null;
    return { id: r.id, name: r.name, rootPath: r.root_path, createdAt: r.created_at };
  }

  /**
   * Switches the active workspace to the named workspace.
   * Validates the root path still exists on disk before switching.
   * Does NOT interrupt in-flight tasks — they keep their original context.
   */
  switchWorkspace(name: string): Workspace {
    const workspace = this.getWorkspaceByName(name);
    if (!workspace) throw new WorkspaceNotFoundError(name);

    if (!fs.existsSync(workspace.rootPath)) {
      throw new WorkspaceError(
        `Cannot switch to workspace "${name}": its root path "${workspace.rootPath}" no longer exists on disk.`
      );
    }

    // Upsert the single-row active_workspace sentinel
    const existing = this.db.prepare('SELECT id FROM active_workspace WHERE id = 1').get();
    if (existing) {
      this.db.prepare('UPDATE active_workspace SET workspace_id = ? WHERE id = 1').run(workspace.id);
    } else {
      this.db.prepare('INSERT INTO active_workspace (id, workspace_id) VALUES (1, ?)').run(workspace.id);
    }

    this.logger.info({ workspaceId: workspace.id, name }, 'Active workspace switched.');
    return workspace;
  }

  /**
   * Clears the active workspace (reverts to config.projectRoot fallback).
   */
  clearActiveWorkspace(): void {
    this.db.prepare('UPDATE active_workspace SET workspace_id = NULL WHERE id = 1').run();
    this.logger.info('Active workspace cleared; falling back to config.projectRoot.');
  }

  /**
   * Returns the currently active workspace, or null if none is set.
   */
  getActiveWorkspace(): Workspace | null {
    const row = this.db.prepare('SELECT workspace_id FROM active_workspace WHERE id = 1').get() as any;
    if (!row || !row.workspace_id) return null;
    return this.getWorkspaceById(row.workspace_id);
  }

  /**
   * Resolves the filesystem root for a given workspace id.
   * Falls back to the provided defaultRoot if workspaceId is null/undefined.
   */
  resolveWorkspaceRoot(workspaceId: string | null | undefined, defaultRoot: string): string {
    if (!workspaceId) return defaultRoot;
    const ws = this.getWorkspaceById(workspaceId);
    return ws ? ws.rootPath : defaultRoot;
  }

  /**
   * Removes a named workspace from the registry.
   *
   * Blocks removal if any tasks with status pending/in-progress/blocked
   * reference this workspace, unless force = true. With force = true,
   * those tasks have their workspace_id set to null (orphaned) rather than
   * being deleted.
   */
  removeWorkspace(name: string, force = false): void {
    const workspace = this.getWorkspaceByName(name);
    if (!workspace) throw new WorkspaceNotFoundError(name);

    // Check for tasks table having workspace_id column (migration-safe)
    const taskTableInfo = this.db.pragma('table_info(tasks)') as { name: string }[];
    const hasWorkspaceColumn = taskTableInfo.some(col => col.name === 'workspace_id');

    if (hasWorkspaceColumn) {
      const blockedStatuses = ['pending', 'in-progress', 'blocked'];
      const placeholders = blockedStatuses.map(() => '?').join(', ');
      const blockedTasks = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? AND status IN (${placeholders})`
        )
        .get(workspace.id, ...blockedStatuses) as { count: number };

      if (blockedTasks.count > 0 && !force) {
        throw new WorkspaceError(
          `Cannot remove workspace "${name}": ${blockedTasks.count} task(s) with status pending/in-progress/blocked still reference it. ` +
          `Resolve those tasks first, or use --force to orphan them (sets their workspace_id to null).`
        );
      }

      if (force) {
        this.db
          .prepare('UPDATE tasks SET workspace_id = NULL WHERE workspace_id = ?')
          .run(workspace.id);
        this.logger.warn({ workspaceId: workspace.id, name }, 'Force-removed workspace; orphaned referencing tasks.');
      }
    }

    // If this was the active workspace, clear the active pointer first
    const active = this.getActiveWorkspace();
    if (active?.id === workspace.id) {
      this.clearActiveWorkspace();
    }

    // Orphan memory entries and kanban boards (set workspace_id = null)
    const memoryTableInfo = this.db.pragma('table_info(memory_entries)') as { name: string }[];
    if (memoryTableInfo.some(col => col.name === 'workspace_id')) {
      this.db.prepare('UPDATE memory_entries SET workspace_id = NULL WHERE workspace_id = ?').run(workspace.id);
    }

    const boardTableInfo = this.db.pragma('table_info(kanban_boards)') as { name: string }[];
    if (boardTableInfo.some(col => col.name === 'workspace_id')) {
      this.db.prepare('UPDATE kanban_boards SET workspace_id = NULL WHERE workspace_id = ?').run(workspace.id);
    }

    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);
    this.logger.info({ workspaceId: workspace.id, name }, 'Workspace removed.');
  }
}
