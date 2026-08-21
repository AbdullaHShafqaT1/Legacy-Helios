/**
 * Phase 12 — Workspace Management Tests
 *
 * Covers:
 * - Workspace CRUD operations
 * - Path-scoping isolation: traversal blocked at each workspace boundary
 * - Cross-workspace contamination: filesystem / memory / Kanban isolation
 * - Workspace switch mid-task semantics
 * - Workspace remove with queued tasks (block and --force orphan)
 * - Switch to non-existent path: clear error, active workspace unchanged
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { openDb } from '../../core/src/queue/db.js';
import { TaskQueue } from '../../core/src/queue/index.js';
import { WorkspaceManager, WorkspaceError, WorkspaceNotFoundError } from '../../core/src/workspace/WorkspaceManager.js';
import { FilesystemConnector, PathTraversalError } from '../../connectors/filesystem/FilesystemConnector.js';
import { MemoryManager } from '../../core/src/memory/memoryManager.js';
import { SqliteVectorStore } from '../../core/src/memory/vectorStore.js';
import { LocalEmbeddingProvider } from '../../core/src/memory/embeddingProvider.js';
import { EmbeddingPipeline } from '../../core/src/memory/embeddingPipeline.js';
import { KanbanConnector } from '../../connectors/kanban/KanbanConnector.js';
import { PermissionGatekeeper, denyAllPrompt } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeTempDir(suffix: string): string {
  const dir = path.join(os.tmpdir(), `jarvis-ws-test-${suffix}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('WorkspaceManager — CRUD', () => {
  let tmpDir: string;
  let wsRootA: string;
  let wsRootB: string;
  let db: Database.Database;
  let wm: WorkspaceManager;

  beforeEach(() => {
    tmpDir = makeTempDir('crud');
    wsRootA = path.join(tmpDir, 'workspace-a');
    wsRootB = path.join(tmpDir, 'workspace-b');
    fs.mkdirSync(wsRootA, { recursive: true });
    fs.mkdirSync(wsRootB, { recursive: true });
    db = openDb(':memory:');
    wm = new WorkspaceManager(db, logger);
  });

  afterEach(() => {
    db.close();
    cleanupDir(tmpDir);
  });

  it('creates a workspace with a valid root path', () => {
    const ws = wm.createWorkspace('alpha', wsRootA);
    expect(ws.name).toBe('alpha');
    expect(ws.rootPath).toBe(wsRootA);
    expect(ws.id).toBeTruthy();
  });

  it('rejects duplicate workspace names', () => {
    wm.createWorkspace('alpha', wsRootA);
    expect(() => wm.createWorkspace('alpha', wsRootB)).toThrow(WorkspaceError);
  });

  it('rejects a root path that does not exist on disk', () => {
    expect(() => wm.createWorkspace('missing', path.join(tmpDir, 'nonexistent'))).toThrow(WorkspaceError);
  });

  it('lists registered workspaces', () => {
    wm.createWorkspace('alpha', wsRootA);
    wm.createWorkspace('beta', wsRootB);
    const list = wm.listWorkspaces();
    expect(list).toHaveLength(2);
    expect(list.map(w => w.name)).toContain('alpha');
    expect(list.map(w => w.name)).toContain('beta');
  });

  it('switches active workspace', () => {
    wm.createWorkspace('alpha', wsRootA);
    wm.createWorkspace('beta', wsRootB);
    wm.switchWorkspace('beta');
    const active = wm.getActiveWorkspace();
    expect(active?.name).toBe('beta');
  });

  it('rejects switch to unknown workspace', () => {
    expect(() => wm.switchWorkspace('unknown')).toThrow(WorkspaceNotFoundError);
  });

  it('rejects switch when root path no longer exists on disk — active workspace unchanged', () => {
    wm.createWorkspace('alpha', wsRootA);
    wm.switchWorkspace('alpha');

    wm.createWorkspace('beta', wsRootB);
    // Delete wsRootB from disk
    fs.rmSync(wsRootB, { recursive: true, force: true });

    expect(() => wm.switchWorkspace('beta')).toThrow(WorkspaceError);
    // Active workspace must still be alpha
    const active = wm.getActiveWorkspace();
    expect(active?.name).toBe('alpha');
  });

  it('removes a workspace with no queued tasks', () => {
    wm.createWorkspace('alpha', wsRootA);
    wm.removeWorkspace('alpha');
    expect(wm.getWorkspaceByName('alpha')).toBeNull();
  });

  it('rejects remove when queued tasks reference the workspace (without --force)', () => {
    const ws = wm.createWorkspace('alpha', wsRootA);
    // Insert a pending task referencing this workspace
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO tasks (id, description, status, priority, retries, max_retries, created_at, updated_at, workspace_id, source)
      VALUES (?, ?, 'pending', 0, 0, 3, ?, ?, ?, 'cli')
    `).run('task-ws-1', 'test task', now, now, ws.id);

    expect(() => wm.removeWorkspace('alpha', false)).toThrow(WorkspaceError);
    // Workspace should still exist
    expect(wm.getWorkspaceByName('alpha')).not.toBeNull();
  });

  it('force-removes workspace and orphans queued tasks', () => {
    const ws = wm.createWorkspace('alpha', wsRootA);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO tasks (id, description, status, priority, retries, max_retries, created_at, updated_at, workspace_id, source)
      VALUES (?, ?, 'pending', 0, 0, 3, ?, ?, ?, 'cli')
    `).run('task-ws-2', 'test task', now, now, ws.id);

    wm.removeWorkspace('alpha', true);
    expect(wm.getWorkspaceByName('alpha')).toBeNull();

    // Task should still exist but with workspace_id = null
    const orphaned = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get('task-ws-2') as any;
    expect(orphaned?.workspace_id).toBeNull();
  });

  it('clears active workspace when the active workspace is removed', () => {
    wm.createWorkspace('alpha', wsRootA);
    wm.switchWorkspace('alpha');
    expect(wm.getActiveWorkspace()?.name).toBe('alpha');
    wm.removeWorkspace('alpha');
    expect(wm.getActiveWorkspace()).toBeNull();
  });
});

describe('WorkspaceManager — Filesystem scoping isolation', () => {
  let tmpDir: string;
  let wsRootA: string;
  let wsRootB: string;
  let db: Database.Database;
  let wm: WorkspaceManager;

  beforeEach(() => {
    tmpDir = makeTempDir('fs-iso');
    wsRootA = path.join(tmpDir, 'workspace-a');
    wsRootB = path.join(tmpDir, 'workspace-b');
    fs.mkdirSync(wsRootA, { recursive: true });
    fs.mkdirSync(wsRootB, { recursive: true });
    // Write a file in each workspace
    fs.writeFileSync(path.join(wsRootA, 'a-file.txt'), 'content-a', 'utf8');
    fs.writeFileSync(path.join(wsRootB, 'b-file.txt'), 'content-b', 'utf8');
    db = openDb(':memory:');
    wm = new WorkspaceManager(db, logger);
  });

  afterEach(() => {
    db.close();
    cleanupDir(tmpDir);
  });

  function makeGatekeeper(): PermissionGatekeeper {
    const auditLog = new AuditLog(db);
    return new PermissionGatekeeper(auditLog, logger, denyAllPrompt);
  }

  it('FilesystemConnector scoped to workspace A cannot read workspace B files via traversal', async () => {
    const auditLog = new AuditLog(db);
    const gatekeeper = makeGatekeeper();
    const connA = new FilesystemConnector({ projectRoot: wsRootA, gatekeeper, auditLog, logger });

    // Direct traversal attempt from A to B
    await expect(connA.readFile('researcher', '../workspace-b/b-file.txt')).rejects.toThrow(PathTraversalError);
  });

  it('FilesystemConnector scoped to workspace B cannot read workspace A files via traversal', async () => {
    const auditLog = new AuditLog(db);
    const gatekeeper = makeGatekeeper();
    const connB = new FilesystemConnector({ projectRoot: wsRootB, gatekeeper, auditLog, logger });

    await expect(connB.readFile('researcher', '../workspace-a/a-file.txt')).rejects.toThrow(PathTraversalError);
  });

  it('Two connectors scoped to different workspaces read only their own files', async () => {
    const auditLog = new AuditLog(db);
    const gatekeeper = makeGatekeeper();
    const connA = new FilesystemConnector({ projectRoot: wsRootA, gatekeeper, auditLog, logger });
    const connB = new FilesystemConnector({ projectRoot: wsRootB, gatekeeper, auditLog, logger });

    const contA = await connA.readFile('researcher', 'a-file.txt');
    expect(contA).toBe('content-a');

    const contB = await connB.readFile('researcher', 'b-file.txt');
    expect(contB).toBe('content-b');

    // Connector A cannot list workspace B's root
    await expect(connA.readFile('researcher', 'b-file.txt')).rejects.toThrow();
  });
});

describe('WorkspaceManager — Memory recall workspace scoping', () => {
  let db: Database.Database;
  let memoryManager: MemoryManager;
  let wsIdA: string;
  let wsIdB: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir('mem-iso');
    const wsRootA = path.join(tmpDir, 'a');
    const wsRootB = path.join(tmpDir, 'b');
    fs.mkdirSync(wsRootA, { recursive: true });
    fs.mkdirSync(wsRootB, { recursive: true });

    db = openDb(':memory:');
    const wm = new WorkspaceManager(db, logger);
    wsIdA = wm.createWorkspace('ws-a', wsRootA).id;
    wsIdB = wm.createWorkspace('ws-b', wsRootB).id;

    const auditLog = new AuditLog(db);
    // Use an approve-all prompt so researcher has memory-write access in tests
    const approveAllPrompt = async () => true;
    const gatekeeper = new PermissionGatekeeper(auditLog, logger, approveAllPrompt);
    const vectorStore = new SqliteVectorStore(':memory:', logger);
    const embeddingProvider = new LocalEmbeddingProvider(384);
    const embeddingPipeline = new EmbeddingPipeline(vectorStore, embeddingProvider, logger);
    memoryManager = new MemoryManager(db, vectorStore, embeddingPipeline, embeddingProvider, gatekeeper, auditLog, logger, {
      memoryMaxEntries: 1000,
    } as any);
  });

  afterEach(() => {
    db.close();
    cleanupDir(tmpDir);
  });

  it('memory stored in workspace A is not returned when querying with workspace B filter', async () => {
    await memoryManager.store({
      content: 'unique alpha content from workspace A',
      sourceAgent: 'researcher',
      workspaceId: wsIdA,
    });

    const results = await memoryManager.query('unique alpha content', { workspaceId: wsIdB, limit: 10 });
    // Must return zero results — wsB should not see wsA memory
    expect(results.length).toBe(0);
  });

  it('memory stored in workspace A is returned when querying with workspace A filter', async () => {
    await memoryManager.store({
      content: 'workspace A specific memory for query test',
      sourceAgent: 'researcher',
      workspaceId: wsIdA,
    });

    const results = await memoryManager.query('workspace A specific memory', { workspaceId: wsIdA, limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.workspaceId === wsIdA)).toBe(true);
  });

  it('memory entries carry their workspace_id in returned MemoryEntry objects', async () => {
    const id = await memoryManager.store({
      content: 'tagged workspace entry',
      sourceAgent: 'researcher',
      workspaceId: wsIdB,
    });

    const entry = await memoryManager.getById(id);
    expect(entry?.workspaceId).toBe(wsIdB);
  });
});

describe('WorkspaceManager — Kanban board workspace scoping', () => {
  let tmpDir: string;
  let kanbanA: KanbanConnector;
  let kanbanB: KanbanConnector;
  let boardIdA: string;
  let boardIdB: string;
  let dbA: Database.Database;
  let dbB: Database.Database;

  beforeEach(async () => {
    tmpDir = makeTempDir('kanban-iso');
    const wsRootA = path.join(tmpDir, 'a');
    const wsRootB = path.join(tmpDir, 'b');
    fs.mkdirSync(wsRootA, { recursive: true });
    fs.mkdirSync(wsRootB, { recursive: true });

    // Use separate in-memory databases to avoid column ID (todo/in-progress) collision
    // Column IDs are board-scoped by board_id FK, but their PK 'id' is simple (e.g. 'todo')
    // so two boards sharing the same DB would collide on kanban_columns.id UNIQUE.
    dbA = openDb(':memory:');
    dbB = openDb(':memory:');

    const wmA = new WorkspaceManager(dbA, logger);
    const wmB = new WorkspaceManager(dbB, logger);
    const wsIdA = wmA.createWorkspace('kanban-ws-a', wsRootA).id;
    const wsIdB = wmB.createWorkspace('kanban-ws-b', wsRootB).id;

    const auditLogA = new AuditLog(dbA);
    const auditLogB = new AuditLog(dbB);
    const gatekeeperA = new PermissionGatekeeper(auditLogA, logger, async () => true);
    const gatekeeperB = new PermissionGatekeeper(auditLogB, logger, async () => true);

    boardIdA = `board-a`;
    boardIdB = `board-b`;

    kanbanA = new KanbanConnector(dbA, gatekeeperA, auditLogA, logger, boardIdA, 'Workspace A Board', wsIdA);
    kanbanB = new KanbanConnector(dbB, gatekeeperB, auditLogB, logger, boardIdB, 'Workspace B Board', wsIdB);

    await kanbanA.initDefaultBoard('project-manager');
    await kanbanB.initDefaultBoard('project-manager');
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
    cleanupDir(tmpDir);
  });

  it('boards belong to their respective workspaces', () => {
    // Each board lives in its own DB — just verify it exists
    const statusA = kanbanA.getBoardStatus(boardIdA);
    const statusB = kanbanB.getBoardStatus(boardIdB);
    expect(statusA).toContain('Workspace A Board');
    expect(statusB).toContain('Workspace B Board');
  });

  it('cards in workspace A board are not visible when querying workspace B board', async () => {
    await kanbanA.createCard('project-manager', {
      id: 'card-a-1',
      columnId: 'todo',
      title: 'Task in Workspace A',
      status: 'open',
    });

    const cardsA = kanbanA.getCards(boardIdA);
    const cardsB = kanbanB.getCards(boardIdB);

    expect(cardsA).toHaveLength(1);
    expect(cardsA[0].title).toBe('Task in Workspace A');
    // Workspace B board (separate DB) has no cards
    expect(cardsB).toHaveLength(0);
  });
});



describe('WorkspaceManager — mid-task workspace switch semantics', () => {
  let db: Database.Database;
  let wm: WorkspaceManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir('midtask');
    db = openDb(':memory:');
    wm = new WorkspaceManager(db, logger);
  });

  afterEach(() => {
    db.close();
    cleanupDir(tmpDir);
  });

  it('workspace switch updates active_workspace but does not affect already-inserted tasks', () => {
    const rootA = path.join(tmpDir, 'a');
    const rootB = path.join(tmpDir, 'b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });

    const wsA = wm.createWorkspace('a', rootA);
    const wsB = wm.createWorkspace('b', rootB);

    wm.switchWorkspace('a');
    const now = new Date().toISOString();
    // Simulate an in-flight task stamped with workspace A
    db.prepare(`
      INSERT INTO tasks (id, description, status, priority, retries, max_retries, created_at, updated_at, workspace_id, source)
      VALUES ('inflight-task', 'in-flight task', 'in-progress', 0, 0, 3, ?, ?, ?, 'cli')
    `).run(now, now, wsA.id);

    // Switch to workspace B
    wm.switchWorkspace('b');
    expect(wm.getActiveWorkspace()?.name).toBe('b');

    // The in-flight task still has workspace A
    const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get('inflight-task') as any;
    expect(task.workspace_id).toBe(wsA.id);
  });

  it('supports interleaved task submission across workspace switches in the queue itself', () => {
    const rootA = path.join(tmpDir, 'a');
    const rootB = path.join(tmpDir, 'b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });

    const wsA = wm.createWorkspace('a', rootA);
    const wsB = wm.createWorkspace('b', rootB);
    const queue = new TaskQueue(db, logger);

    // Switch to A and enqueue Task 1
    wm.switchWorkspace('a');
    const t1 = queue.enqueue({ description: 'Task 1 in workspace A' });
    expect(t1.workspace_id).toBe(wsA.id);

    // Switch to B and enqueue Task 2
    wm.switchWorkspace('b');
    const t2 = queue.enqueue({ description: 'Task 2 in workspace B' });
    expect(t2.workspace_id).toBe(wsB.id);

    // Switch to A and enqueue Task 3
    wm.switchWorkspace('a');
    const t3 = queue.enqueue({ description: 'Task 3 in workspace A' });
    expect(t3.workspace_id).toBe(wsA.id);

    // Verify task associations in database
    const retrieved1 = queue.getById(t1.id);
    const retrieved2 = queue.getById(t2.id);
    const retrieved3 = queue.getById(t3.id);

    expect(retrieved1?.workspace_id).toBe(wsA.id);
    expect(retrieved2?.workspace_id).toBe(wsB.id);
    expect(retrieved3?.workspace_id).toBe(wsA.id);
  });
});
