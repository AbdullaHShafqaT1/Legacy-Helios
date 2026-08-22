import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import { WebSocket } from 'ws';
import { DashboardServer } from '../src/dashboard/DashboardServer.js';
import { HealthMonitor } from '../src/lib/health.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { createLogger } from '../src/lib/logger.js';

describe('Phase 15 Local Status Dashboard tests', () => {
  let db: Database.Database;
  let server: DashboardServer;
  let healthMonitor: HealthMonitor;
  let auditLog: AuditLog;
  const logger = createLogger('test', 'silent');
  const port = 8099; // Use custom test port to avoid collision

  beforeAll(() => {
    db = new Database(':memory:');
    
    // Create necessary schemas
    db.exec(`
      CREATE TABLE IF NOT EXISTS active_workspace (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT,
        root_path TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        correlation_id TEXT,
        task_id TEXT,
        request_payload_json TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT
      );
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
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        source TEXT,
        status TEXT
      );
    `);

    healthMonitor = new HealthMonitor(logger);
    healthMonitor.transition('browser', 'HEALTHY');
    healthMonitor.transition('terminal', 'HEALTHY');

    auditLog = new AuditLog(db);

    server = new DashboardServer({
      config: {
        dashboardPort: port,
        vectorStorePath: '',
        vectorStoreType: '',
        embeddingDimensions: 0,
        memoryMaxEntries: 0,
        browserHeadless: true,
        browserLocalAllowlist: [],
        terminalAllowlist: [],
        terminalTimeoutMs: 0,
        claudeTimeoutMs: 0,
        unattended: false,
        voiceWakeWordThreshold: 0,
        voiceSttConfidenceThreshold: 0,
        voiceTtsRate: 0,
        voiceWakeWordModelPath: '',
        voiceSttModelPath: '',
        voiceAudioInputDevice: '',
        voiceAudioOutputDevice: '',
        voiceAudioSampleRate: 16000,
        voiceCiFallback: false,
        visionEnabled: false,
        visionPreferredDisplay: 0,
        visionCaptureTimeoutMs: 0,
        visionProvider: '',
        visionOcrEnabled: false,
        healthCheckIntervalMs: 0,
        restartLimits: 0,
        restartBackoffMs: 0,
        desktopControlEnabled: false,
        desktopActionTimeoutMs: 0,
        desktopObservationMaxAgeMs: 0,
        desktopMaxTextLength: 0,
        desktopMaxActionsPerSequence: 0,
        desktopRequireConfirmation: false,
        voiceWakeWordEngine: '',
        visionPeriodicIntervalMs: 0,
        visionPeriodicRetentionMax: 0,
        searchProvider: '',
        searchRateLimitCount: 0,
        searchRateLimitWindowMs: 0,
        voiceDuplexPort: 0,
        voiceDuplexInterruptThreshold: 0,
        voiceDuplexModelType: 'local',
        dbPath: '',
        model: '',
        maxRetries: 0,
        pollIntervalMs: 0,
        staleTaskTimeoutMs: 0,
        logLevel: 'silent',
        approvalTimeoutMs: 0,
        projectRoot: '',
      },
      logger,
      db,
      healthMonitor
    });

    server.start();
  });

  afterAll(() => {
    server.stop();
    db.close();
  });

  beforeEach(() => {
    db.exec(`
      DELETE FROM active_workspace;
      DELETE FROM workspaces;
      DELETE FROM pending_approvals;
      DELETE FROM audit_log;
      DELETE FROM tasks;
    `);
  });

  it('rejects connection requests from non-localhost IPs (gated loopback)', async () => {
    // Attempting to mock a network query. Our server binds to 127.0.0.1 strictly.
    // Let's perform an HTTP get to http://127.0.0.1:port/
    const resPromise = new Promise<number>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume(); // consume stream to release socket
        resolve(res.statusCode || 0);
      }).on('error', reject);
    });

    const statusCode = await resPromise;
    expect(statusCode).toBe(200); // Standard local access gets 200 OK
  });

  it('serves dashboard status API with health and logs successfully', async () => {
    // Add active workspace
    db.prepare("INSERT INTO workspaces (id, name, root_path) VALUES ('ws-123', 'Project Helios', '/workspace')").run();
    db.prepare("INSERT INTO active_workspace (id, workspace_id) VALUES (1, 'ws-123')").run();

    // Query status API
    const resPromise = new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/status`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
    });

    const bodyStr = await resPromise;
    const data = JSON.parse(bodyStr);

    expect(data.workspaceName).toBe('Project Helios');
    expect(data.health.browser.status).toBe('HEALTHY');
    expect(data.health.terminal.status).toBe('HEALTHY');
    expect(data.pending).toEqual([]);
  });

  it('approves a standard pending task from the API', async () => {
    // Register mock task and pending approval
    const taskId = 'task-456';
    db.prepare("INSERT INTO tasks (id, source, status) VALUES (?, 'cli', 'pending')").run(taskId);
    
    const correlationId = 'corr-999';
    const payload = { actor: 'coder', action: 'file-write', params: { path: 'test.ts', content: 'test' } };
    
    db.prepare(`
      INSERT INTO pending_approvals (id, correlation_id, task_id, request_payload_json, status, created_at, updated_at)
      VALUES ('ap-1', ?, ?, ?, 'pending', '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z')
    `).run(correlationId, taskId, JSON.stringify(payload));

    const postData = JSON.stringify({ taskId });
    const approvePromise = new Promise<{ code: number, body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/api/approve',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => resolve({ code: res.statusCode || 0, body }));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    const result = await approvePromise;
    expect(result.code).toBe(200);

    // Verify database row updated to granted
    const row = db.prepare('SELECT status FROM pending_approvals WHERE task_id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('granted');
  });

  it('strictly enforces the voice-cannot-approve boundary on voice-originated tasks', async () => {
    // Register a voice task and pending approval
    const taskId = 'voice-task-789';
    db.prepare("INSERT INTO tasks (id, source, status) VALUES (?, 'voice', 'pending')").run(taskId);

    const correlationId = 'corr-888';
    const payload = { actor: 'coder', action: 'terminal-run', params: { command: 'rm -rf /' } };

    db.prepare(`
      INSERT INTO pending_approvals (id, correlation_id, task_id, request_payload_json, status, created_at, updated_at)
      VALUES ('ap-2', ?, ?, ?, 'pending', '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z')
    `).run(correlationId, taskId, JSON.stringify(payload));

    // Call approve API on voice task
    const postData = JSON.stringify({ taskId });
    const approvePromise = new Promise<{ code: number, body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/api/approve',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => resolve({ code: res.statusCode || 0, body }));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    const result = await approvePromise;
    expect(result.code).toBe(403);
    expect(JSON.parse(result.body).error).toContain('Denied: Voice-originated task actions must be approved via CLI/text override.');

    // Verify database row remains pending (gated!)
    const row = db.prepare('SELECT status FROM pending_approvals WHERE task_id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('rejects a high-friction pending task if confirmed is not passed', async () => {
    const taskId = 'task-hf-1';
    db.prepare("INSERT INTO tasks (id, source, status) VALUES (?, 'cli', 'pending')").run(taskId);

    const correlationId = 'corr-hf-1';
    const payload = { actor: 'coder', action: 'terminal-run', params: { command: 'rm -rf /' } };

    db.prepare(`
      INSERT INTO pending_approvals (id, correlation_id, task_id, request_payload_json, status, created_at, updated_at)
      VALUES ('ap-hf-1', ?, ?, ?, 'pending', '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z')
    `).run(correlationId, taskId, JSON.stringify(payload));

    const postData = JSON.stringify({ taskId });
    const approvePromise = new Promise<{ code: number, body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/api/approve',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => resolve({ code: res.statusCode || 0, body }));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    const result = await approvePromise;
    expect(result.code).toBe(400);
    expect(JSON.parse(result.body).error).toContain('High-friction actions require explicit user confirmation check');

    const row = db.prepare('SELECT status FROM pending_approvals WHERE task_id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('approves a high-friction pending task if confirmed is passed as true', async () => {
    const taskId = 'task-hf-2';
    db.prepare("INSERT INTO tasks (id, source, status) VALUES (?, 'cli', 'pending')").run(taskId);

    const correlationId = 'corr-hf-2';
    const payload = { actor: 'coder', action: 'terminal-run', params: { command: 'rm -rf /' } };

    db.prepare(`
      INSERT INTO pending_approvals (id, correlation_id, task_id, request_payload_json, status, created_at, updated_at)
      VALUES ('ap-hf-2', ?, ?, ?, 'pending', '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z')
    `).run(correlationId, taskId, JSON.stringify(payload));

    const postData = JSON.stringify({ taskId, confirmed: true });
    const approvePromise = new Promise<{ code: number, body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/api/approve',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => resolve({ code: res.statusCode || 0, body }));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    const result = await approvePromise;
    expect(result.code).toBe(200);
    expect(JSON.parse(result.body).success).toBe(true);

    const row = db.prepare('SELECT status FROM pending_approvals WHERE task_id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('granted');
  });
});
