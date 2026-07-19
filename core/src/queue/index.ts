import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Logger } from 'pino';

/**
 * Custom error thrown by the TaskQueue class.
 */
export class TaskQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskQueueError';
    Object.setPrototypeOf(this, TaskQueueError.prototype);
  }
}

/**
 * Structure representing the task database row.
 */
export interface TaskRow {
  id: string;
  description: string;
  file_context: string | null;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'blocked';
  priority: number;
  depends_on: string | null;
  retries: number;
  max_retries: number;
  error: string | null;
  result_json: string | null;
  locked_by: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  sequence_id: number;
}

/**
 * Input structure for enqueuing a new task.
 */
export interface EnqueueInput {
  id?: string;
  description: string;
  fileContext?: unknown;
  priority?: number;
  dependsOn?: string;
  maxRetries?: number;
}

export class TaskQueue {
  private db: Database.Database;
  private logger: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Enqueues a new task. Supports duplicate check idempotency.
   *
   * @param input Task specification parameters.
   * @returns The created or existing TaskRow.
   * @throws TaskQueueError if validation or dependency checks fail.
   */
  enqueue(input: EnqueueInput): TaskRow {
    if (!input.description || input.description.trim() === '') {
      throw new TaskQueueError('Task description cannot be empty or whitespace.');
    }

    // Idempotent duplicate submission check
    if (input.id) {
      const existing = this.getById(input.id);
      if (existing) {
        this.logger.info({ taskId: input.id }, 'Duplicate task submission detected. Returning existing task row unchanged.');
        return existing;
      }
    }

    const taskId = input.id || crypto.randomUUID();

    // Verify dependency task exists
    if (input.dependsOn) {
      const dependency = this.getById(input.dependsOn);
      if (!dependency) {
        throw new TaskQueueError(`Dependency task with ID "${input.dependsOn}" does not exist.`);
      }
    }

    const fileContextStr = input.fileContext !== undefined ? JSON.stringify(input.fileContext) : null;
    const now = new Date().toISOString();

    const insertStmt = this.db.prepare(`
      INSERT INTO tasks (
        id, description, file_context, status, priority, depends_on, retries, max_retries, created_at, updated_at, sequence_id
      ) VALUES (?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, (SELECT COALESCE(MAX(sequence_id), 0) + 1 FROM tasks))
    `);

    insertStmt.run(
      taskId,
      input.description.trim(),
      fileContextStr,
      input.priority ?? 0,
      input.dependsOn ?? null,
      input.maxRetries ?? 3,
      now,
      now
    );

    const inserted = this.getById(taskId);
    if (!inserted) {
      throw new TaskQueueError(`Failed to retrieve task with ID "${taskId}" after insertion.`);
    }

    return inserted;
  }

  /**
   * Retrieves a task by its unique identifier.
   */
  getById(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  /**
   * Lists all tasks in the queue, ordered from newest to oldest.
   */
  listAll(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY sequence_id DESC').all() as TaskRow[];
  }

  /**
   * Atomically claims the next eligible task from the queue for execution.
   *
   * @param agentName Name of the claiming agent thread.
   * @returns The claimed TaskRow, or null if no tasks are eligible.
   */
  claimNext(agentName: string): TaskRow | null {
    // 1. Resolve blocked dependencies first
    this.resolveBlockedDependencies();

    // 2. Fetch pending tasks sorted by priority DESC, sequence_id ASC
    const candidates = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
      ORDER BY priority DESC, sequence_id ASC
    `).all() as TaskRow[];

    for (const candidate of candidates) {
      // 3. Skip if depends_on task is not 'completed'
      if (candidate.depends_on) {
        const dep = this.getById(candidate.depends_on);
        if (!dep || dep.status !== 'completed') {
          continue; // Leave pending, try next
        }
      }

      // 4. Atomically claim task (checks and handles target state update race condition)
      const now = new Date().toISOString();
      const claimStmt = this.db.prepare(`
        UPDATE tasks
        SET status = 'in-progress', locked_by = ?, heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `);

      const result = claimStmt.run(agentName, now, now, candidate.id);
      if (result.changes === 1) {
        return this.getById(candidate.id) || null;
      }
      // If result.changes === 0, another runner claimed it between SELECT and UPDATE. Loop to next.
    }

    return null;
  }

  /**
   * Updates task's heartbeat timestamp during running execution.
   */
  heartbeat(taskId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks
      SET heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND status = 'in-progress'
    `).run(now, now, taskId);
  }

  /**
   * Marks a task as completed with its outcome result data.
   */
  complete(taskId: string, result: unknown): void {
    const now = new Date().toISOString();
    const resultJson = JSON.stringify(result);
    
    const completeStmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'completed', result_json = ?, heartbeat_at = NULL, locked_by = NULL, updated_at = ?
      WHERE id = ?
    `);

    const resultRun = completeStmt.run(resultJson, now, taskId);
    if (resultRun.changes === 0) {
      throw new TaskQueueError(`Failed to complete task: Task with ID "${taskId}" not found.`);
    }
  }

  /**
   * Sets task state as failed, incrementing retries and evaluating status transitions.
   *
   * @param taskId Unique task identifier.
   * @param error Descriptive error context message.
   * @returns Object describing whether the task will be rescheduled.
   */
  fail(taskId: string, error: string): { willRetry: boolean } {
    const task = this.getById(taskId);
    if (!task) {
      throw new TaskQueueError(`Task with ID "${taskId}" not found.`);
    }

    const now = new Date().toISOString();

    // Atomic SQLite statement mapping counter increments and status updates dynamically
    const failStmt = this.db.prepare(`
      UPDATE tasks
      SET retries = retries + 1,
          status = CASE WHEN retries + 1 <= max_retries THEN 'pending' ELSE 'failed' END,
          heartbeat_at = NULL,
          locked_by = NULL,
          error = ?,
          updated_at = ?
      WHERE id = ?
    `);

    const runResult = failStmt.run(error, now, taskId);
    if (runResult.changes === 0) {
      throw new TaskQueueError(`Failed to update task failure: Task with ID "${taskId}" not found.`);
    }

    const updated = this.getById(taskId);
    if (!updated) {
      throw new TaskQueueError(`Failed to retrieve task with ID "${taskId}" after fail operation.`);
    }

    return {
      willRetry: updated.status === 'pending',
    };
  }

  /**
   * Recovers crashed tasks that haven't updated their heartbeats within the timeout period.
   *
   * @param timeoutMs Timeout interval in milliseconds.
   * @returns Array of recovered and updated TaskRow objects.
   */
  recoverStaleTasks(timeoutMs: number): TaskRow[] {
    const inProgressTasks = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'in-progress'
    `).all() as TaskRow[];

    const recovered: TaskRow[] = [];
    const nowTime = Date.now();

    for (const task of inProgressTasks) {
      const isStale = !task.heartbeat_at || (nowTime - new Date(task.heartbeat_at).getTime() > timeoutMs);
      
      if (isStale) {
        this.logger.warn({ taskId: task.id }, 'Recovering stale/stuck task. Setting state to fail for retry check.');
        this.fail(task.id, 'Recovered from crash: task was in-progress with a stale heartbeat.');
        
        const updated = this.getById(task.id);
        if (updated) {
          recovered.push(updated);
        }
      }
    }

    return recovered;
  }

  /**
   * Transitively updates pending tasks to 'blocked' if their dependencies failed or are blocked.
   */
  private resolveBlockedDependencies(): void {
    let changed = true;
    
    while (changed) {
      changed = false;
      
      const dependentTasks = this.db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'pending' AND depends_on IS NOT NULL
      `).all() as TaskRow[];

      for (const task of dependentTasks) {
        const dep = this.getById(task.depends_on!);
        if (dep && (dep.status === 'failed' || dep.status === 'blocked')) {
          const now = new Date().toISOString();
          const blockReason = `Blocked: dependency task '${dep.id}' has status '${dep.status}' and will not complete.`;
          
          this.db.prepare(`
            UPDATE tasks
            SET status = 'blocked', error = ?, updated_at = ?
            WHERE id = ?
          `).run(blockReason, now, task.id);

          this.logger.warn(
            { taskId: task.id, dependencyId: dep.id, dependencyStatus: dep.status },
            `Task is now BLOCKED because its dependency will not complete.`
          );
          
          changed = true; // Cascade update check down the DAG
        }
      }
    }
  }
}
