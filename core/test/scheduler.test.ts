import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/queue/db.js';
import { TaskQueue } from '../src/queue/index.js';
import { createLogger } from '../src/lib/logger.js';
import fs from 'node:fs';

const logger = createLogger('test', 'silent');

describe('Scheduler test', () => {
  it('should skip missed runs if missedRunPolicy is skip', () => {
    const dbPath = 'memory-store/scheduler-test-skip.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    
    const db = openDb(dbPath);
    const queue = new TaskQueue(db, logger);

  queue.scheduleTask({
    id: 'test-cron-skip',
    description: 'Scheduled Task Skip',
    scheduleExpression: '*/5 * * * * *', // Every 5 seconds
    missedRunPolicy: 'skip'
  });

  // Manually manipulate next_run_at to simulate missed runs
  const past = new Date(Date.now() - 30000).toISOString();
  db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(past, 'test-cron-skip');

    queue.evaluateScheduledTasks();

    const tasks = queue.listAll();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe('Scheduled Task Skip');

    db.close();
    fs.unlinkSync(dbPath);
  });

  it('should catch-up missed runs if missedRunPolicy is catch-up', () => {
    const dbPath = 'memory-store/scheduler-test-catchup.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  
  const db = openDb(dbPath);
  const queue = new TaskQueue(db, logger);

  queue.scheduleTask({
    id: 'test-cron-catchup',
    description: 'Scheduled Task Catchup',
    scheduleExpression: '*/5 * * * * *', // Every 5 seconds
    missedRunPolicy: 'catch-up'
  });

  // Simulate missed runs over last 20 seconds (should equal 4 missed runs)
  const past = new Date(Date.now() - 20000).toISOString();
  db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(past, 'test-cron-catchup');

    queue.evaluateScheduledTasks();

    const tasks = queue.listAll();
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks[0].description).toContain('Scheduled run for');

    db.close();
    fs.unlinkSync(dbPath);
  });

  it('should throw an error if scheduleExpression is malformed', () => {
    const dbPath = 'memory-store/scheduler-test-malformed.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    
    const db = openDb(dbPath);
    const queue = new TaskQueue(db, logger);

    expect(() => {
      queue.scheduleTask({
        id: 'test-cron-invalid',
        description: 'Invalid Cron',
        scheduleExpression: 'invalid-cron-string',
        missedRunPolicy: 'skip'
      });
    }).toThrow('Invalid cron expression');

    db.close();
    fs.unlinkSync(dbPath);
  });
});
