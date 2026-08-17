import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/queue/db.js';
import { TaskQueue } from '../src/queue/index.js';
import { createLogger } from '../src/lib/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const logger = createLogger('test', 'silent');

describe('Resumption test', () => {
  it('should recover stale tasks after a real process restart', () => {
    const dbPath = 'memory-store/resumption-real-test.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    
    // Create DB and enqueue task
    let db = openDb(dbPath);
    let queue = new TaskQueue(db, logger);
    queue.enqueue({ id: 'task-real-restart', description: 'Test OS-level restart' });
    const claimed = queue.claimNext('agent-1');
    expect(claimed).toBeDefined();
    expect(claimed?.status).toBe('in-progress');

    // Create a temporary script that opens the DB and simulates being the worker process
    const scriptPath = path.join(__dirname, 'temp-worker.mjs');
    fs.writeFileSync(scriptPath, `
      import Database from 'better-sqlite3';
      const db = new Database('${dbPath.replace(/\\/g, '/')}');
      // Update heartbeat to be stale (10 mins ago) to simulate a crash that happened in the past
      const past = new Date(Date.now() - 600000).toISOString();
      db.prepare('UPDATE tasks SET heartbeat_at = ? WHERE id = ?').run(past, 'task-real-restart');
      db.close();
      process.exit(0);
    `);

    // Run the script in a separate OS process
    const result = spawnSync('node', [scriptPath]);
    if (result.status !== 0) {
       console.error(result.stderr?.toString() || result.stdout?.toString());
    }
    expect(result.status).toBe(0);

    // Clean up temp script
    fs.unlinkSync(scriptPath);

    // Now in our main process (the "restarted" orchestrator), try to recover
    const recovered = queue.recoverStaleTasks(300000); // 5 mins timeout
    
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('pending');
    expect(recovered[0].retries).toBe(1);

    db.close();
    fs.unlinkSync(dbPath);
  });
});
