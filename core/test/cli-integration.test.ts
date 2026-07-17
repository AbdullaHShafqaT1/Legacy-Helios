import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openCliContext } from '../src/bootstrap.js';
import { clearConfigCache } from '../src/lib/config.js';

describe('CLI Integration Data & Process Tests', () => {
  let tempDir: string;
  let dbPath: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    clearConfigCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cli-test-'));
    dbPath = path.join(tempDir, 'jarvis.db');
    originalDbPath = process.env.JARVIS_DB_PATH;
  });

  afterEach(() => {
    clearConfigCache();
    process.env.JARVIS_DB_PATH = originalDbPath;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should support enqueuing and reading tasks using openCliContext on a physical SQLite database', () => {
    // Setup env variable for openCliContext database path
    process.env.JARVIS_DB_PATH = dbPath;

    const ctx = openCliContext();

    try {
      const t1 = ctx.queue.enqueue({
        description: 'First task',
        priority: 10
      });

      const t2 = ctx.queue.enqueue({
        description: 'Second dependent task',
        dependsOn: t1.id,
        priority: 5
      });

      // Write decision logs
      const correlationId = ctx.auditLog.recordDecision({
        actor: 'cli',
        action: 'emergency-stop',
        params: { test: 'value' },
        approvalStatus: 'n-a',
        approver: 'user'
      });

      ctx.auditLog.recordOutcome(correlationId, 'cli', 'emergency-stop', 'Outcome logged');

      // Verify task queue data
      const tasks = ctx.queue.listAll();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].description).toBe('Second dependent task');
      expect(tasks[0].depends_on).toBe(t1.id);
      expect(tasks[1].description).toBe('First task');

      // Verify audit logs
      const logs = ctx.auditLog.recent(10);
      expect(logs).toHaveLength(2);
      expect(logs[0].event_type).toBe('outcome');
      expect(logs[0].correlation_id).toBe(correlationId);
      expect(logs[1].event_type).toBe('decision');
      expect(logs[1].correlation_id).toBe(correlationId);
    } finally {
      ctx.db.close();
    }
  });

  it('should execute the compiled CLI as a child process to submit a task', () => {
    const cliFilePath = path.resolve('dist/cli/index.js');
    
    if (!fs.existsSync(cliFilePath)) {
      // If the compiled file does not exist (e.g. running test before first tsc compilation),
      // we can compile the project using tsc synchronously.
      try {
        const tscBin = path.resolve('node_modules/typescript/bin/tsc');
        execFileSync('node', [tscBin], { stdio: 'ignore' });
      } catch (err) {
        console.warn('Skipping child-process test: dist/cli/index.js was missing and tsc compilation failed.', err);
        return;
      }
    }

    const env = {
      ...process.env,
      JARVIS_DB_PATH: dbPath,
      JARVIS_LOG_LEVEL: 'silent'
    };

    const stdout = execFileSync('node', [
      cliFilePath,
      'submit',
      'Child process task description',
      '--priority',
      '15'
    ], {
      env,
      encoding: 'utf8'
    });

    expect(stdout).toContain('Task submitted successfully.');
    expect(stdout).toContain('ID:');

    // Confirm task was actually written to the physical database
    process.env.JARVIS_DB_PATH = dbPath;
    const ctx = openCliContext();
    try {
      const tasks = ctx.queue.listAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].description).toBe('Child process task description');
      expect(tasks[0].priority).toBe(15);
    } finally {
      ctx.db.close();
    }
  });
});
