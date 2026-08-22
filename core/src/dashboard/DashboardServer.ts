import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Config } from '../lib/config.js';
import { HealthMonitor } from '../lib/health.js';
import { PeriodicCaptureManager } from '../../../services/PeriodicCaptureManager.js';
import { redactSecrets } from '../lib/redact.js';

export interface DashboardServerOptions {
  config: Config;
  logger: Logger;
  db: Database.Database;
  healthMonitor: HealthMonitor;
  periodicCaptureManager?: PeriodicCaptureManager;
}

export class DashboardServer {
  private config: Config;
  private logger: Logger;
  private db: Database.Database;
  private healthMonitor: HealthMonitor;
  private periodicCaptureManager?: PeriodicCaptureManager;

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private wsClients = new Set<WebSocket>();
  private activeSockets = new Set<any>();
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(options: DashboardServerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.db = options.db;
    this.healthMonitor = options.healthMonitor;
    this.periodicCaptureManager = options.periodicCaptureManager;
  }

  /**
   * Starts the Dashboard HTTP and WebSocket server on localhost strictly.
   */
  start(): void {
    const port = this.config.dashboardPort;
    this.logger.info({ port }, 'Starting Local Status Dashboard server');

    try {
      this.server = createServer((req, res) => this.handleHttpRequest(req, res));

      this.server.on('connection', (socket) => {
        this.activeSockets.add(socket);
        socket.on('close', () => {
          this.activeSockets.delete(socket);
        });
      });
      
      // Strict loopback-only binding
      this.server.listen(port, '127.0.0.1', () => {
        this.logger.info(`Dashboard server running at http://127.0.0.1:${port}`);
      });

      this.wss = new WebSocketServer({ noServer: true });
      
      this.server.on('upgrade', (request, socket, head) => {
        // Enforce strict local loopback checks on upgrade requests
        const remoteAddress = (socket as any).remoteAddress;
        if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : '';
        if (pathname === '/ws') {
          this.wss?.handleUpgrade(request, socket, head, (ws) => {
            this.wss?.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      });

      this.wss.on('connection', (ws) => {
        this.wsClients.add(ws);
        this.logger.debug('Dashboard client connected via WebSocket');

        // Send initial state immediately
        try {
          ws.send(JSON.stringify({ type: 'init', data: this.getDashboardState() }));
        } catch {}

        ws.on('close', () => {
          this.wsClients.delete(ws);
        });
      });

      // Poll database for state changes periodically and broadcast
      this.pollInterval = setInterval(() => {
        if (this.wsClients.size > 0) {
          this.broadcastState();
        }
      }, 2000);

      this.server.on('close', () => {
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = null;
        }
      });

    } catch (err: any) {
      this.logger.error({ err }, 'Failed to start Dashboard server');
    }
  }

  /**
   * Stops the server and closes client connections.
   */
  stop(): void {
    this.logger.info('Stopping Dashboard server...');
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    for (const ws of this.wsClients) {
      try {
        ws.close();
      } catch {}
    }
    this.wsClients.clear();

    if (this.wss) {
      try {
        this.wss.close();
      } catch {}
      this.wss = null;
    }

    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {}
    }
    this.activeSockets.clear();

    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
  }

  private broadcastState(): void {
    const state = this.getDashboardState();
    const payload = JSON.stringify({ type: 'update', data: state });
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // Restrict requests to local loopback strictly
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Access Forbidden: Dashboard is loopback-only.');
      return;
    }

    const reqUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getDashboardHtml());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getDashboardState()));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/screenshot') {
      this.handleScreenshotRequest(res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/approve') {
      this.handleApprovalRequest(req, res, 'granted');
      return;
    }

    if (req.method === 'POST' && pathname === '/api/deny') {
      this.handleApprovalRequest(req, res, 'denied');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handleScreenshotRequest(res: ServerResponse): void {
    if (!this.periodicCaptureManager || !this.periodicCaptureManager.isActive()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Periodic capture offline');
      return;
    }

    const paths = this.periodicCaptureManager.getCapturedPaths();
    const latestPath = paths[paths.length - 1];

    if (!latestPath || !fs.existsSync(latestPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No screenshot captured yet');
      return;
    }

    try {
      const data = fs.readFileSync(latestPath);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to load screenshot: ${err.message}`);
    }
  }

  private handleApprovalRequest(req: IncomingMessage, res: ServerResponse, decision: 'granted' | 'denied'): void {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const taskId = payload.taskId;

        if (!taskId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'taskId parameter is required' }));
          return;
        }

        // Voice gating check: verify task source
        const row = this.db.prepare('SELECT source FROM tasks WHERE id = ?').get(taskId) as { source: string } | undefined;
        if (row?.source === 'voice') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Denied: Voice-originated task actions must be approved via CLI/text override.' }));
          return;
        }

        // Server-side High-friction validation check
        if (decision === 'granted') {
          const pendingRow = this.db.prepare("SELECT request_payload_json FROM pending_approvals WHERE task_id = ? AND status = 'pending'").get(taskId) as { request_payload_json: string } | undefined;
          if (pendingRow) {
            try {
              const payloadParsed = JSON.parse(pendingRow.request_payload_json);
              const action = payloadParsed.action;
              const isHighFriction = ['git-force-push', 'git-history-rewrite', 'destructive', 'terminal-run'].includes(action);
              if (isHighFriction && !payload.confirmed) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Denied: High-friction actions require explicit user confirmation check.' }));
                return;
              }
            } catch (jsonErr) {
              this.logger.error({ jsonErr }, 'Failed to parse request_payload_json for high friction check');
            }
          }
        }

        const now = new Date().toISOString();
        const updateStmt = this.db.prepare(`
          UPDATE pending_approvals 
          SET status = ?, updated_at = ?
          WHERE task_id = ? AND status = 'pending'
        `);
        const result = updateStmt.run(decision, now, taskId);

        if (result.changes > 0) {
          this.broadcastState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No pending approvals found for this task' }));
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private getDashboardState(): any {
    // 1. Active Workspace Name
    let activeWorkspaceName = 'Default Workspace';
    try {
      const workspaceRow = this.db.prepare(`
        SELECT w.name FROM active_workspace a
        JOIN workspaces w ON a.workspace_id = w.id
        WHERE a.id = 1
      `).get() as { name: string } | undefined;
      if (workspaceRow) {
        activeWorkspaceName = workspaceRow.name;
      }
    } catch {}

    // 2. Health monitor statuses
    const healthReport = this.healthMonitor.getReport();
    const health: Record<string, { status: string; lastError?: string; details?: string }> = {};
    for (const h of healthReport) {
      health[h.name] = {
        status: h.state,
        lastError: h.lastError,
        details: h.details
      };
    }

    // 3. Pending approvals list
    const pendingRows = this.db.prepare(`
      SELECT correlation_id, task_id, request_payload_json, created_at FROM pending_approvals
      WHERE status = 'pending'
      ORDER BY created_at DESC
    `).all() as { correlation_id: string; task_id: string; request_payload_json: string; created_at: string }[];

    const pending = pendingRows.map(row => {
      let payloadParsed = {};
      try {
        payloadParsed = redactSecrets(JSON.parse(row.request_payload_json)) as any;
      } catch {}
      return {
        correlationId: row.correlation_id,
        taskId: row.task_id,
        payload: payloadParsed,
        createdAt: row.created_at
      };
    });

    // 4. Recent audit log actions
    const auditRows = this.db.prepare(`
      SELECT event_type, actor, action, params_json, approval_status, approver, timestamp FROM audit_log
      ORDER BY id DESC LIMIT 15
    `).all() as { event_type: string; actor: string; action: string; params_json: string | null; approval_status: string; approver: string | null; timestamp: string }[];

    const auditLogs = auditRows.map(row => {
      let params = {};
      if (row.params_json) {
        try {
          params = redactSecrets(JSON.parse(row.params_json)) as any;
        } catch {}
      }
      return {
        eventType: row.event_type,
        actor: row.actor,
        action: row.action,
        params,
        approvalStatus: row.approval_status,
        approver: row.approver,
        timestamp: row.timestamp
      };
    });

    return {
      workspaceName: activeWorkspaceName,
      health,
      pending,
      auditLogs,
      screenshotActive: Boolean(this.periodicCaptureManager?.isActive())
    };
  }

  private getDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis Helios Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0b0f19;
      --card-bg: rgba(22, 28, 45, 0.45);
      --border-color: rgba(255, 255, 255, 0.08);
      --glow-green: #10b981;
      --glow-red: #ef4444;
      --glow-blue: #3b82f6;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
    }

    body {
      background-color: var(--bg-color);
      color: var(--text-main);
      font-family: 'Outfit', sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(16, 185, 129, 0.1));
      border-bottom: 1px solid var(--border-color);
      padding: 20px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      backdrop-filter: blur(10px);
    }

    .logo-container {
      display: flex;
      align-items: center;
      gap: 15px;
    }

    .logo {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: 1px;
      background: linear-gradient(to right, #3b82f6, #10b981);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .active-workspace {
      background: rgba(59, 130, 246, 0.2);
      border: 1px solid rgba(59, 130, 246, 0.3);
      padding: 6px 15px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 600;
      color: #93c5fd;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .pulse {
      width: 8px;
      height: 8px;
      background-color: var(--glow-green);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--glow-green);
      animation: pulse-animation 2s infinite;
    }

    @keyframes pulse-animation {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    .main-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 30px;
      padding: 40px;
      flex-grow: 1;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 25px;
      backdrop-filter: blur(16px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }

    .card-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text-main);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      padding-bottom: 10px;
    }

    .health-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 15px;
      margin-bottom: 25px;
    }

    .health-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 15px;
      text-align: center;
      transition: transform 0.2s, border-color 0.2s;
    }

    .health-item:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .health-name {
      font-size: 14px;
      color: var(--text-muted);
      text-transform: capitalize;
      margin-bottom: 8px;
    }

    .health-status {
      font-size: 16px;
      font-weight: 600;
    }

    .status-healthy { color: var(--glow-green); }
    .status-failed { color: var(--glow-red); }

    .screenshot-container {
      position: relative;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--border-color);
      background: #000;
      aspect-ratio: 16/9;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .screenshot-img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .screenshot-offline {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(11, 15, 25, 0.85);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-weight: 600;
      gap: 10px;
    }

    .pending-queue {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }

    .approval-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      transition: box-shadow 0.3s, border-color 0.3s;
    }

    .approval-high-friction {
      border-color: rgba(239, 68, 68, 0.3);
      box-shadow: 0 0 15px rgba(239, 68, 68, 0.1);
    }

    .approval-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
      font-size: 14px;
    }

    .action-badge {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      padding: 3px 8px;
      border-radius: 6px;
      font-weight: 600;
    }

    .badge-friction {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
    }

    .approval-details {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      background: rgba(0, 0, 0, 0.2);
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 15px;
      white-space: pre-wrap;
      word-break: break-all;
      border: 1px solid rgba(255, 255, 255, 0.03);
    }

    .friction-gate {
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 15px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .approval-actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }

    button {
      padding: 8px 18px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-family: 'Outfit', sans-serif;
      transition: background 0.2s, transform 0.1s;
    }

    button:active {
      transform: scale(0.98);
    }

    .btn-approve {
      background: var(--glow-green);
      color: #fff;
      border: none;
    }

    .btn-approve:hover {
      background: #059669;
    }

    .btn-approve:disabled {
      background: #344054;
      cursor: not-allowed;
      opacity: 0.5;
    }

    .btn-deny {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-main);
    }

    .btn-deny:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .logs-timeline {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: 400px;
      overflow-y: auto;
      padding-right: 5px;
    }

    .log-item {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.01);
      border-left: 3px solid transparent;
    }

    .log-item:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    .log-left {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .log-action {
      font-weight: 600;
      font-family: 'JetBrains Mono', monospace;
    }

    .log-params {
      font-size: 11px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      max-width: 450px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .log-right {
      text-align: right;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2px;
    }

    .log-status {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .log-granted { border-left-color: var(--glow-green); color: var(--glow-green); }
    .log-denied { border-left-color: var(--glow-red); color: var(--glow-red); }
    .log-pending { border-left-color: var(--glow-blue); color: var(--glow-blue); }

    .voice-gated-warning {
      color: var(--glow-red);
      font-weight: 600;
      font-size: 12px;
      margin-top: 5px;
    }

    ::-webkit-scrollbar {
      width: 6px;
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <header>
    <div class="logo-container">
      <div class="pulse"></div>
      <div class="logo">HELIOS OS</div>
    </div>
    <div class="active-workspace" id="active-workspace">
      Default Workspace
    </div>
  </header>

  <div class="main-grid">
    <div style="display: flex; flex-direction: column; gap: 30px;">
      <!-- System Health Card -->
      <div class="card">
        <div class="card-title">System Health status</div>
        <div class="health-grid" id="health-grid">
          <!-- Populated dynamically -->
        </div>
      </div>

      <!-- Pending Authorization Queue -->
      <div class="card" style="flex-grow: 1;">
        <div class="card-title">Pending Authorization Queue</div>
        <div class="pending-queue" id="pending-queue">
          <!-- Populated dynamically -->
        </div>
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 30px;">
      <!-- Desktop Feed Frame -->
      <div class="card">
        <div class="card-title">Desktop Screenshot Feed</div>
        <div class="screenshot-container">
          <img id="screenshot-img" class="screenshot-img" src="/api/screenshot" alt="Desktop Screenshot" onerror="this.style.display='none'">
          <div class="screenshot-offline" id="screenshot-offline">
            <span>Camera Feed Offline</span>
          </div>
        </div>
      </div>

      <!-- Activity Timeline -->
      <div class="card">
        <div class="card-title">Activity Audit Timeline</div>
        <div class="logs-timeline" id="logs-timeline">
          <!-- Populated dynamically -->
        </div>
      </div>
    </div>
  </div>

  <script>
    const socket = new WebSocket('ws://' + window.location.host + '/ws');
    
    // Auto-refresh screenshots every 4 seconds
    setInterval(() => {
      const img = document.getElementById('screenshot-img');
      if (img && img.style.display !== 'none') {
        img.src = '/api/screenshot?t=' + Date.now();
      }
    }, 4000);

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'init' || message.type === 'update') {
        updateDashboard(message.data);
      }
    };

    function updateDashboard(data) {
      // 1. Workspace
      document.getElementById('active-workspace').innerText = data.workspaceName;

      // 2. Health
      const healthGrid = document.getElementById('health-grid');
      healthGrid.innerHTML = '';
      for (const [key, val] of Object.entries(data.health)) {
        const item = document.createElement('div');
        item.className = 'health-item';
        item.innerHTML = \`
          <div class="health-name">\${key}</div>
          <div class="health-status \${val.status === 'HEALTHY' ? 'status-healthy' : 'status-failed'}">\${val.status}</div>
        \`;
        healthGrid.appendChild(item);
      }

      // 3. Screenshot active check
      const offlineOverlay = document.getElementById('screenshot-offline');
      const screenshotImg = document.getElementById('screenshot-img');
      if (data.screenshotActive) {
        offlineOverlay.style.display = 'none';
        screenshotImg.style.display = 'block';
      } else {
        offlineOverlay.style.display = 'flex';
        screenshotImg.style.display = 'none';
      }

      // 4. Pending Queue
      const queue = document.getElementById('pending-queue');
      queue.innerHTML = '';
      
      if (data.pending.length === 0) {
        queue.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 40px;">No actions pending user authorization.</div>';
      } else {
        data.pending.forEach(item => {
          const div = document.createElement('div');
          const isHighFriction = ['git-force-push', 'git-history-rewrite', 'destructive', 'terminal-run'].includes(item.payload.action);
          const isVoiceTask = item.payload.params && item.payload.params.actingOnBehalfOf === 'voice';

          div.className = 'approval-item' + (isHighFriction ? ' approval-high-friction' : '');
          
          let frictionHtml = '';
          if (isHighFriction) {
            frictionHtml = \`
              <div class="friction-gate">
                <input type="checkbox" id="friction-chk-\${item.taskId}" onchange="toggleApproveBtn('\${item.taskId}')">
                <label for="friction-chk-\${item.taskId}">I confirm that executing this action is safe.</label>
              </div>
            \`;
          }

          let voiceWarningHtml = '';
          if (isVoiceTask) {
            voiceWarningHtml = '<div class="voice-gated-warning">Voice-originated tasks cannot be approved via Dashboard. Please use standard CLI overrides.</div>';
          }

          div.innerHTML = \`
            <div class="approval-header">
              <span class="action-badge \${isHighFriction ? 'badge-friction' : ''}">\${item.payload.action}</span>
              <span style="color: var(--text-muted)">Actor: \${item.payload.actor}</span>
            </div>
            <div class="approval-details">\${JSON.stringify(item.payload.params, null, 2)}</div>
            \${frictionHtml}
            \${voiceWarningHtml}
            <div class="approval-actions">
              <button class="btn-deny" onclick="resolveApproval('\${item.taskId}', 'deny')">Deny</button>
              <button class="btn-approve" id="btn-approve-\${item.taskId}" \${isHighFriction || isVoiceTask ? 'disabled' : ''} onclick="resolveApproval('\${item.taskId}', 'approve')">Approve</button>
            </div>
          \`;
          queue.appendChild(div);
        });
      }

      // 5. Audit Log
      const timeline = document.getElementById('logs-timeline');
      timeline.innerHTML = '';
      data.auditLogs.forEach(log => {
        const div = document.createElement('div');
        div.className = 'log-item';
        const formattedStatus = log.approvalStatus === 'n-a' ? 'N/A' : log.approvalStatus;
        
        let statusClass = 'log-pending';
        if (log.approvalStatus === 'granted') statusClass = 'log-granted';
        if (log.approvalStatus === 'denied') statusClass = 'log-denied';

        div.innerHTML = \`
          <div class="log-left">
            <div class="log-action">\${log.action}</div>
            <div class="log-params">\${JSON.stringify(log.params)}</div>
          </div>
          <div class="log-right">
            <div class="log-status \${statusClass}">\${formattedStatus}</div>
            <div style="font-size: 10px; color: var(--text-muted)">\${log.actor}</div>
          </div>
        \`;
        timeline.appendChild(div);
      });
    }

    function toggleApproveBtn(taskId) {
      const chk = document.getElementById('friction-chk-' + taskId);
      const btn = document.getElementById('btn-approve-' + taskId);
      if (btn) {
        btn.disabled = !chk.checked;
      }
    }

    async function resolveApproval(taskId, decision) {
      try {
        const res = await fetch('/api/' + decision, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId })
        });
        const data = await res.json();
        if (data.error) {
          alert('Error: ' + data.error);
        }
      } catch (err) {
        alert('Failed to resolve action: ' + err.message);
      }
    }
  </script>
</body>
</html>
`;
  }
}
