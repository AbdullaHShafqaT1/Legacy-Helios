import { describe, it, expect } from 'vitest';
import { BrowserConnector } from '../../connectors/browser/BrowserConnector.js';
import { PermissionGatekeeper, denyAllPrompt } from '../src/permissions/gatekeeper.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import fs from 'node:fs';
import { executionContext } from '../src/lib/context.js';
import { Page } from 'playwright';

const logger = createLogger('test', 'silent');

describe('BrowserConnector concurrency', () => {
  it('should create distinct sessions per task', async () => {
    const dbPath = 'memory-store/browser-concurrency-test.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const db = openDb(dbPath);
    const auditLog = new AuditLog(db);
    const gatekeeper = new PermissionGatekeeper(auditLog, logger, denyAllPrompt);

  const browser = new BrowserConnector({
    gatekeeper,
    auditLog,
    logger,
    headless: true
  });

  // Access private method ensureBrowser for testing via any cast
  const ensureBrowser = (browser as any).ensureBrowser.bind(browser);

  let page1: Page | null = null;
  let page2: Page | null = null;

    await Promise.all([
      executionContext.run({ taskId: 'task-A' }, async () => {
        page1 = await ensureBrowser();
      }),
      executionContext.run({ taskId: 'task-B' }, async () => {
        page2 = await ensureBrowser();
      })
    ]);

    expect(page1).toBeDefined();
    expect(page2).toBeDefined();
    expect(page1).not.toBe(page2);

    await browser.close(); // Clean up all sessions
    db.close();
    fs.unlinkSync(dbPath);
  });
});
