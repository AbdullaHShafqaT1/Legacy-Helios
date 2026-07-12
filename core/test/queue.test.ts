import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import { TaskQueue, TaskQueueError } from '../src/queue/index.js';

describe('TaskQueue Class', () => {
  let db: any;
  let logger: any;
  let queue: TaskQueue;

  beforeEach(() => {
    db = openDb(':memory:');
    logger = createLogger('test-logger', 'silent'); // mute logging during tests
    queue = new TaskQueue(db, logger);
  });

  it('should apply correct defaults and reject empty description during enqueue', () => {
    // Empty description rejection
    expect(() => queue.enqueue({ description: '  ' })).toThrow(TaskQueueError);
    expect(() => queue.enqueue({ description: '' })).toThrow(TaskQueueError);

    // Apply correct defaults
    const task = queue.enqueue({ description: 'Valid Task' });
    expect(task.id).toBeDefined();
    expect(task.status).toBe('pending');
    expect(task.priority).toBe(0);
    expect(task.retries).toBe(0);
    expect(task.max_retries).toBe(3);
    expect(task.depends_on).toBeNull();
    expect(task.file_context).toBeNull();
  });

  it('should be idempotent on duplicate submission with explicit ID', () => {
    const original = queue.enqueue({ id: 'task-100', description: 'Original task', priority: 1 });
    const duplicate = queue.enqueue({ id: 'task-100', description: 'Different description', priority: 5 });

    // Returns original task unchanged
    expect(duplicate.id).toBe(original.id);
    expect(duplicate.description).toBe('Original task');
    expect(duplicate.priority).toBe(1);

    const allTasks = queue.listAll();
    expect(allTasks).toHaveLength(1);
  });

  it('should verify dependency task existence during enqueue', () => {
    expect(() => queue.enqueue({ description: 'Task dependent on ghost', dependsOn: 'ghost-1' })).toThrow(TaskQueueError);
    
    queue.enqueue({ id: 'parent-1', description: 'Parent' });
    expect(() => queue.enqueue({ description: 'Child', dependsOn: 'parent-1' })).not.toThrow();
  });

  it('should claimNext respecting priority ordering and tie-breaker sorting', () => {
    queue.enqueue({ id: 't1', description: 'Low priority', priority: 0 });
    queue.enqueue({ id: 't2', description: 'High priority', priority: 10 });
    queue.enqueue({ id: 't3', description: 'Medium priority', priority: 5 });

    const first = queue.claimNext('agent-1');
    expect(first?.id).toBe('t2');

    const second = queue.claimNext('agent-1');
    expect(second?.id).toBe('t3');

    const third = queue.claimNext('agent-1');
    expect(third?.id).toBe('t1');
  });

  it('should not claim a task whose dependency has not completed', () => {
    queue.enqueue({ id: 'parent', description: 'Parent task' });
    queue.enqueue({ id: 'child', description: 'Child task', dependsOn: 'parent' });

    // Parent is 'pending', child cannot be claimed
    const claim = queue.claimNext('agent-1');
    expect(claim?.id).toBe('parent'); // claims parent, child left pending
    
    const nextClaim = queue.claimNext('agent-1');
    expect(nextClaim).toBeNull(); // child cannot be claimed yet

    // Complete parent
    queue.complete('parent', { ok: true });

    // Child can now be claimed
    const finalClaim = queue.claimNext('agent-1');
    expect(finalClaim?.id).toBe('child');
  });

  it('should mark child task as blocked with descriptive reason when parent dependency fails or is blocked', () => {
    queue.enqueue({ id: 'parent', description: 'Parent task' });
    queue.enqueue({ id: 'child', description: 'Child task', dependsOn: 'parent' });
    queue.enqueue({ id: 'grandchild', description: 'Grandchild task', dependsOn: 'child' });

    // Fail parent task permanently
    queue.fail('parent', 'Parent crashed badly'); // first try (retries = 1)
    queue.fail('parent', 'Parent crashed badly'); // second try (retries = 2)
    queue.fail('parent', 'Parent crashed badly'); // third try (retries = 3)
    const parentState = queue.fail('parent', 'Parent crashed badly'); // fourth try (retries = 4, maxRetries = 3)
    expect(parentState.willRetry).toBe(false);

    const checkParent = queue.getById('parent');
    expect(checkParent?.status).toBe('failed');

    // Attempt to claim next to trigger dependency resolution
    const claim = queue.claimNext('agent-1');
    expect(claim).toBeNull(); // Nothing to claim

    // Verify child and grandchild are marked as blocked
    const checkChild = queue.getById('child');
    expect(checkChild?.status).toBe('blocked');
    expect(checkChild?.error).toContain("Blocked: dependency task 'parent' has status 'failed'");

    const checkGrandchild = queue.getById('grandchild');
    expect(checkGrandchild?.status).toBe('blocked');
    expect(checkGrandchild?.error).toContain("Blocked: dependency task 'child' has status 'blocked'");
  });

  it('should fail() incrementing retries, rescheduling if <= max_retries, and permanently failing if exceeded', () => {
    queue.enqueue({ id: 'test-task', description: 'Retrying task', maxRetries: 2 });

    const f1 = queue.fail('test-task', 'Err 1');
    expect(f1.willRetry).toBe(true);
    expect(queue.getById('test-task')?.status).toBe('pending');
    expect(queue.getById('test-task')?.retries).toBe(1);

    const f2 = queue.fail('test-task', 'Err 2');
    expect(f2.willRetry).toBe(true);
    expect(queue.getById('test-task')?.status).toBe('pending');
    expect(queue.getById('test-task')?.retries).toBe(2);

    const f3 = queue.fail('test-task', 'Err 3');
    expect(f3.willRetry).toBe(false);
    expect(queue.getById('test-task')?.status).toBe('failed');
    expect(queue.getById('test-task')?.retries).toBe(3);
    expect(queue.getById('test-task')?.error).toBe('Err 3');
  });

  it('should recover stale in-progress tasks back to pending or mark as failed', () => {
    queue.enqueue({ id: 't-stale', description: 'Stale task', maxRetries: 1 });
    
    // Claim task to set it to in-progress
    queue.claimNext('agent-1');
    const taskBefore = queue.getById('t-stale');
    expect(taskBefore?.status).toBe('in-progress');
    expect(taskBefore?.locked_by).toBe('agent-1');

    // Simulate stale heartbeat by hacking heartbeat_at timestamp in database
    const oldTime = new Date(Date.now() - 100000).toISOString();
    db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = 't-stale'").run(oldTime);

    // Recover stale task with 30s timeout
    const recovered = queue.recoverStaleTasks(30000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe('t-stale');
    expect(recovered[0].status).toBe('pending');
    expect(recovered[0].retries).toBe(1);
    expect(recovered[0].locked_by).toBeNull();
    expect(recovered[0].heartbeat_at).toBeNull();

    // Re-claim and make stale again
    queue.claimNext('agent-1');
    db.prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = 't-stale'").run(oldTime);

    // Recover again, should exceed maxRetries = 1
    const recoveredFinal = queue.recoverStaleTasks(30000);
    expect(recoveredFinal[0].status).toBe('failed');
    expect(recoveredFinal[0].retries).toBe(2);
  });

  it('should maintain task status on fresh queue instance re-attachment (persistence)', () => {
    queue.enqueue({ id: 'persisted', description: 'Persistence test task' });

    // Create a new queue instance on the same db
    const secondQueue = new TaskQueue(db, logger);
    const task = secondQueue.getById('persisted');
    
    expect(task).toBeDefined();
    expect(task?.status).toBe('pending');
  });
});
