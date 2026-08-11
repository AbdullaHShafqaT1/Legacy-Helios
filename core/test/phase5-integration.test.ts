import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { TaskQueue } from '../src/queue/index.js';
import { ModelRouter } from '../src/router/modelRouter.js';
import { AgentRouter } from '../src/router/agentRouter.js';
import { MessageRouter } from '../src/router/messageRouter.js';
import { ResearcherAgent } from '../../agents/researcher/ResearcherAgent.js';
import { TerminalOperatorAgent } from '../../agents/terminal-operator/TerminalOperatorAgent.js';
import { BrowserOperatorAgent } from '../../agents/browser-operator/BrowserOperatorAgent.js';
import { TerminalConnector } from '../../connectors/terminal/TerminalConnector.js';
import { BrowserConnector } from '../../connectors/browser/BrowserConnector.js';
import { FilesystemConnector } from '../../connectors/filesystem/FilesystemConnector.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { SqliteVectorStore } from '../src/memory/vectorStore.js';
import { LocalEmbeddingProvider } from '../src/memory/embeddingProvider.js';
import { EmbeddingPipeline } from '../src/memory/embeddingPipeline.js';
import { JarvisEventBus } from '../src/events/bus.js';
import { clearConfigCache } from '../src/lib/config.js';

describe('Phase 5 - Delegation Safety, Browser, and Terminal Operator Integration Tests', () => {
  let tempDir: string;
  let db: any;
  let auditLog: AuditLog;
  let queue: TaskQueue;
  let logger: any;
  let mockStandardPrompt: any;
  let mockHighFrictionPrompt: any;
  let gatekeeper: PermissionGatekeeper;
  let terminalConnector: TerminalConnector;
  let browserConnector: BrowserConnector;
  let filesystemConnector: FilesystemConnector;
  let modelRouter: ModelRouter;
  let agentRouter: AgentRouter;
  let messageRouter: MessageRouter;
  let eventBus: JarvisEventBus;
  let memoryManager: MemoryManager;

  let researcher: ResearcherAgent;
  let terminalOperator: TerminalOperatorAgent;
  let browserOperator: BrowserOperatorAgent;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase5-int-'));
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('phase5-int-logger', 'silent');
    eventBus = new JarvisEventBus();
    queue = new TaskQueue(db, logger, eventBus);

    mockStandardPrompt = vi.fn().mockResolvedValue(true);
    mockHighFrictionPrompt = vi.fn().mockResolvedValue(true);

    gatekeeper = new PermissionGatekeeper(
      auditLog,
      logger,
      mockStandardPrompt,
      undefined,
      mockHighFrictionPrompt
    );

    filesystemConnector = new FilesystemConnector({
      projectRoot: tempDir,
      gatekeeper,
      auditLog,
      logger,
    });

    terminalConnector = new TerminalConnector({
      projectRoot: tempDir,
      gatekeeper,
      auditLog,
      logger,
      timeoutMs: 5000,
    });

    browserConnector = new BrowserConnector({
      gatekeeper,
      auditLog,
      logger,
      headless: true,
    });

    modelRouter = new ModelRouter();
    modelRouter.register({
      taskTypes: ['coding', 'reasoning', 'research'],
      invoke: async () => ({ text: '{}' }),
    });

    const vectorStore = new SqliteVectorStore(':memory:', logger);
    const embeddingProvider = new LocalEmbeddingProvider(384);
    const embeddingPipeline = new EmbeddingPipeline(vectorStore, embeddingProvider, logger);
    memoryManager = new MemoryManager(
      db,
      vectorStore,
      embeddingPipeline,
      embeddingProvider,
      gatekeeper,
      auditLog,
      logger,
      { memoryMaxEntries: 100 } as any
    );

    agentRouter = new AgentRouter();
    messageRouter = new MessageRouter(agentRouter, auditLog, logger, 5, 2000);

    researcher = new ResearcherAgent(
      modelRouter,
      filesystemConnector,
      memoryManager,
      logger,
      messageRouter,
      gatekeeper,
      auditLog
    );
    agentRouter.register(researcher);

    terminalOperator = new TerminalOperatorAgent(
      modelRouter,
      terminalConnector,
      memoryManager,
      logger,
      messageRouter
    );
    agentRouter.register(terminalOperator);

    browserOperator = new BrowserOperatorAgent(
      modelRouter,
      browserConnector,
      memoryManager,
      logger,
      messageRouter
    );
    agentRouter.register(browserOperator);

    // Register emergency stop hook in test eventBus
    eventBus.on('queue:emergency-stop', () => {
      terminalConnector.killAll().catch(() => {});
      browserConnector.close().catch(() => {});
    });

    process.env.JARVIS_TERMINAL_ALLOWLIST = 'node -v';
    process.env.JARVIS_PROJECT_ROOT = tempDir;
    clearConfigCache();
  });

  afterEach(async () => {
    await browserConnector.close();
    await terminalConnector.killAll();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.JARVIS_TERMINAL_ALLOWLIST;
    delete process.env.JARVIS_PROJECT_ROOT;
    clearConfigCache();
  });

  describe('Objective 3: Delegation Safety Extended to High-Risk Actions', () => {
    it('should ALLOW delegated terminal command execution if the acting agent (terminal-operator) policy allow-list permits it, logging both agents in Audit Log', async () => {
      // Researcher (originating agent, who does NOT have terminal permissions)
      // sends Terminal Operator (acting agent) a message requesting execution of "node -v" (low-risk command).
      const requestMsg = {
        id: crypto.randomUUID(),
        sender: 'researcher',
        recipient: 'terminal-operator',
        type: 'terminal-run',
        payload: { command: 'node -v' },
        timestamp: new Date().toISOString(),
      };

      const response = await messageRouter.sendAndReceive(requestMsg);
      expect(response.payload.success).toBe(true);

      // Verify Audit Log records both acting agent and originating agent
      const recent = auditLog.recent();
      const runDecision = recent.find((r) => r.event_type === 'decision' && r.action === 'terminal-run');
      expect(runDecision).toBeDefined();
      expect(runDecision?.actor).toBe('terminal-operator'); // acting agent
      expect(runDecision?.approval_status).toBe('granted');
      expect(runDecision?.approver).toBe('policy'); // low-risk command is auto-approved by policy

      const params = JSON.parse(runDecision?.params_json || '{}');
      expect(params.actingOnBehalfOf).toBe('researcher'); // originating agent
    });

    it('should REQUIRE high-friction confirmation if delegated terminal command is not in the allow-list, checking acting agent policy', async () => {
      mockHighFrictionPrompt.mockResolvedValue(true);

      const scriptPath = path.join(tempDir, 'print42.js');
      fs.writeFileSync(scriptPath, 'console.log("42");');

      const requestMsg = {
        id: crypto.randomUUID(),
        sender: 'researcher',
        recipient: 'terminal-operator',
        type: 'terminal-run',
        payload: { command: `node ${scriptPath}` }, // not in allow-list
        timestamp: new Date().toISOString(),
      };

      const response = await messageRouter.sendAndReceive(requestMsg);
      expect(response.payload.success).toBe(true);
      expect(response.payload.stdout.trim()).toBe('42');

      // Verify Audit Log records high friction approval by user
      const recent = auditLog.recent();
      const runDecision = recent.find((r) => r.event_type === 'decision' && r.action === 'terminal-run');
      expect(runDecision).toBeDefined();
      expect(runDecision?.approver).toBe('user');
      expect(mockHighFrictionPrompt).toHaveBeenCalled();
    });

    it('should BLOCK delegated browser navigate to file:// URL (restricted resource) from Researcher', async () => {
      const requestMsg = {
        id: crypto.randomUUID(),
        sender: 'researcher',
        recipient: 'browser-operator',
        type: 'browser-navigate',
        payload: { url: 'file:///etc/passwd' },
        timestamp: new Date().toISOString(),
      };

      const response = await messageRouter.sendAndReceive(requestMsg);
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('permission not granted');

      // Verify Audit Log decision row shows browser-admin denied
      const recent = auditLog.recent();
      const adminDecision = recent.find(
        (r) => r.event_type === 'decision' && r.action === 'browser-admin' && r.actor === 'browser-operator'
      );
      expect(adminDecision).toBeDefined();
      expect(adminDecision?.approval_status).toBe('denied');
      expect(adminDecision?.approver).toBe('system');
    });
  });

  describe('Emergency Stop Gating', () => {
    it('should terminate running terminal commands immediately when emergency stop signal is sent', async () => {
      const scriptPath = path.join(tempDir, 'infinite.js');
      fs.writeFileSync(scriptPath, 'setInterval(() => {}, 1000);');

      // Execute command in background via connector without waiting
      const promise = terminalConnector.execute('terminal-operator', `node ${scriptPath}`);

      // Wait a bit to ensure process started
      await new Promise(r => setTimeout(r, 500));

      // Emit emergency stop
      eventBus.emit('queue:emergency-stop');

      const result = await promise;
      expect(result.exitCode).toBeNull();
      // On emergency stop, the child process is killed
    });
  });
});
