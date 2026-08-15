import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/queue/db.js';
import { TaskQueue } from '../src/queue/index.js';
import { createLogger } from '../src/lib/logger.js';
import fs from 'node:fs';

const logger = createLogger('test', 'silent');

describe('Resumption test', () => {
  it('should recover stale tasks after restart', () => {
    const dbPath = 'memory-store/resumption-test.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    
    let db = openDb(dbPath);
    let queue = new TaskQueue(db, logger);

    queue.enqueue({ id: 'task-restart', description: 'Test restart' });
    const claimed = queue.claimNext('agent-1');
    expect(claimed).toBeDefined();
    expect(claimed?.status).toBe('in-progress');

    // Simulate process crash (do not complete task, just close DB)
    db.close();

    // Restart process
    db = openDb(dbPath);
    queue = new TaskQueue(db, logger);

    // Manually backdate the heartbeat_at to simulate stale state
    const past = new Date(Date.now() - 600000).toISOString();
    db.prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?').run(past, 'task-restart');

    // Recover
    const recovered = queue.recoverStaleTasks(300000); // 5 mins timeout
    
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('pending');
    expect(recovered[0].retries).toBe(1);

    db.close();
    fs.unlinkSync(dbPath);
  });
});
