import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PeriodicCaptureManager } from '../../services/PeriodicCaptureManager.js';
import { ComputerVisionConnector } from '../../connectors/vision/ComputerVisionConnector.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { JarvisEventBus } from '../src/events/bus.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { ModelRouter } from '../src/router/modelRouter.js';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 13 Periodic Vision Capture Manager', () => {
  let db: Database.Database;
  let logger: pino.Logger;
  let eventBus: JarvisEventBus;
  let auditLog: AuditLog;
  let gatekeeper: PermissionGatekeeper;
  let modelRouter: ModelRouter;
  let memoryManager: MemoryManager;
  let cvConnector: ComputerVisionConnector;
  let manager: PeriodicCaptureManager;
  let createdFiles: string[] = [];

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT,
        event_type TEXT,
        timestamp TEXT,
        actor TEXT,
        action TEXT,
        params_json TEXT,
        approval_status TEXT,
        approver TEXT,
        outcome TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT,
        task_id TEXT,
        action TEXT,
        params_json TEXT,
        status TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT,
        source_agent TEXT,
        source_task_id TEXT,
        tag TEXT,
        timestamp TEXT
      );
    `);

    logger = pino({ level: 'silent' });
    eventBus = new JarvisEventBus();
    auditLog = new AuditLog(db);
    
    // Approval mock that grants all requested actions
    gatekeeper = new PermissionGatekeeper(auditLog, logger, async () => true);

    modelRouter = new ModelRouter();
    // Register a mock model route for vision
    modelRouter.register({
      taskTypes: ['vision'],
      invoke: async (ctx) => ({
        text: `Analyzed screen describing input: ${ctx.description} containing secret sk-ant-123456789abc`,
      }),
    });

    cvConnector = new ComputerVisionConnector({
      gatekeeper,
      auditLog,
      modelRouter,
      logger,
    });

    // Mock captureScreen to generate temp files we can test FIFO retention with
    vi.spyOn(cvConnector, 'captureScreen').mockImplementation(async () => {
      const tempPath = path.join(os.tmpdir(), `test_capture_${Math.random()}.png`);
      fs.writeFileSync(tempPath, 'fake-png-content');
      createdFiles.push(tempPath);
      return {
        success: true,
        timestamp: new Date().toISOString(),
        display: 0,
        width: 1280,
        height: 720,
        screenshotPath: tempPath,
        imageFixtureFallbackUsed: false,
      };
    });

    memoryManager = {
      store: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    } as any;

    manager = new PeriodicCaptureManager({
      computerVisionConnector: cvConnector,
      gatekeeper,
      eventBus,
      memoryManager,
      modelRouter,
      logger,
      intervalMs: 50, // fast intervals for testing
      retentionMax: 3, // only keep 3 screenshots
    });
  });

  afterEach(() => {
    manager.stop();
    db.close();
    for (const f of createdFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }
    createdFiles = [];
  });

  it('requires periodic-start permission to run', async () => {
    // Deny authorization
    const denyGatekeeper = new PermissionGatekeeper(auditLog, logger, async () => false);
    const restrictedManager = new PeriodicCaptureManager({
      computerVisionConnector: cvConnector,
      gatekeeper: denyGatekeeper,
      eventBus,
      memoryManager,
      modelRouter,
      logger,
    });

    const success = await restrictedManager.start('researcher');
    expect(success).toBe(false);
    expect(restrictedManager.isActive()).toBe(false);
  });

  it('runs capture loop, performs analysis with redaction, stores to memory, and applies FIFO retention', async () => {
    const startSuccess = await manager.start('researcher');
    expect(startSuccess).toBe(true);
    expect(manager.isActive()).toBe(true);

    // Wait for at least 4 cycles to trigger FIFO retention
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(cvConnector.captureScreen).toHaveBeenCalled();
    expect(memoryManager.store).toHaveBeenCalled();

    // Verify secrets are redacted before storing in Memory
    const storeCalls = (memoryManager.store as any).mock.calls;
    expect(storeCalls.length).toBeGreaterThan(0);
    const memoryContent = storeCalls[0][0].content;
    expect(memoryContent).toContain('[REDACTED]'); // sk-ant-... must be redacted
    expect(memoryContent).not.toContain('sk-ant-123456789abc');

    // Verify FIFO retention deleted older files
    // At most 3 files should exist on disk from the list of createdFiles
    const existingCount = createdFiles.filter(f => fs.existsSync(f)).length;
    expect(existingCount).toBeLessThanOrEqual(3);
  });

  it('halts capture immediately upon emergency-stop event', async () => {
    await manager.start('researcher');
    expect(manager.isActive()).toBe(true);

    eventBus.emit('queue:emergency-stop');
    expect(manager.isActive()).toBe(false);
  });
});
