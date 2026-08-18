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
import { ModelRouter, ModelRequestContext, ModelResponse } from '../src/router/modelRouter.js';
import { FilesystemConnector } from '../../connectors/filesystem/FilesystemConnector.js';
import { KanbanConnector } from '../../connectors/kanban/KanbanConnector.js';
import { AgentRouter } from '../src/router/agentRouter.js';
import { MessageRouter, MessageLoopError } from '../src/router/messageRouter.js';
import { SoftwareEngineerAgent } from '../../agents/software-engineer/SoftwareEngineerAgent.js';
import { CodeReviewerAgent } from '../../agents/code-reviewer/CodeReviewerAgent.js';
import { ProjectManagerAgent } from '../../agents/project-manager/ProjectManagerAgent.js';
import { ResearcherAgent } from '../../agents/researcher/ResearcherAgent.js';
import { JarvisEventBus } from '../src/events/bus.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { SqliteVectorStore } from '../src/memory/vectorStore.js';
import { LocalEmbeddingProvider } from '../src/memory/embeddingProvider.js';
import { EmbeddingPipeline } from '../src/memory/embeddingPipeline.js';

describe('Phase 4 - Swarms, Messaging, Kanban, and Delegation Integration Tests', () => {
  let tempDir: string;
  let db: any;
  let auditLog: AuditLog;
  let queue: TaskQueue;
  let logger: any;
  let mockStandardPrompt: any;
  let mockHighFrictionPrompt: any;
  let gatekeeper: PermissionGatekeeper;
  let filesystemConnector: FilesystemConnector;
  let kanbanConnector: KanbanConnector;
  let modelRouter: ModelRouter;
  let agentRouter: AgentRouter;
  let messageRouter: MessageRouter;
  let eventBus: JarvisEventBus;
  let memoryManager: MemoryManager;

  let softwareEngineer: SoftwareEngineerAgent;
  let researcher: ResearcherAgent;
  let codeReviewer: CodeReviewerAgent;
  let projectManager: ProjectManagerAgent;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phase4-int-'));
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('phase4-int-logger', 'silent');
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

    kanbanConnector = new KanbanConnector(
      db,
      gatekeeper,
      auditLog,
      logger
    );

    modelRouter = new ModelRouter();
    modelRouter.register({
      taskTypes: ['coding', 'reasoning', 'research'],
      invoke: async (context: ModelRequestContext): Promise<ModelResponse> => {
        if (context.description.includes('JSON format')) {
          if (context.description.includes('fail-review')) {
            return {
              text: JSON.stringify({
                verdict: 'request-changes',
                issues: [{ severity: 'error', message: 'Syntactic issue.' }],
                explanation: 'Rejection!',
              }),
            };
          }
          return {
            text: JSON.stringify({
              verdict: 'approved',
              issues: [],
              explanation: 'Approve!',
            }),
          };
        }
        return { text: 'function main() { return 42; }' };
      },
    });

    // Vector Store and memory manager setup
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
    messageRouter = new MessageRouter(
      agentRouter,
      auditLog,
      logger,
      5, // max hops
      1000 // 1s timeout
    );

    softwareEngineer = new SoftwareEngineerAgent(
      modelRouter,
      gatekeeper,
      auditLog,
      memoryManager,
      logger,
      messageRouter
    );
    agentRouter.register(softwareEngineer, { isDefault: true });

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

    codeReviewer = new CodeReviewerAgent(
      modelRouter,
      filesystemConnector,
      messageRouter,
      logger
    );
    agentRouter.register(codeReviewer);

    projectManager = new ProjectManagerAgent(
      modelRouter,
      kanbanConnector,
      queue,
      messageRouter,
      logger
    );
    agentRouter.register(projectManager);

    // Event bus connections
    eventBus.on('task:created', (data) => {
      projectManager.handleTaskCreated(data);
    });
    eventBus.on('task:started', (data) => {
      projectManager.handleTaskStarted(data);
    });
    eventBus.on('task:completed', (data) => {
      projectManager.handleTaskCompleted(data);
    });
    eventBus.on('task:failed', (data) => {
      projectManager.handleTaskFailed(data);
    });

    // Init default board
    await kanbanConnector.initDefaultBoard('project-manager');
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { }
  });

  describe('1. Agent-to-Agent Messaging Routing & Schemas', () => {
    it('should route message and deliver reply using correlationId', async () => {
      const request: any = {
        id: crypto.randomUUID(),
        sender: 'software-engineer' as any,
        recipient: 'code-reviewer' as any,
        type: 'review-request',
        payload: {
          taskId: 't-1',
          description: 'Review mock write',
          filesChanged: [],
        },
        timestamp: new Date().toISOString(),
      };

      const reply = await messageRouter.sendAndReceive(request);
      expect(reply.sender).toBe('code-reviewer');
      expect(reply.recipient).toBe('software-engineer');
      expect(reply.type).toBe('review-result');
      expect(reply.correlationId).toBe(request.id);
      expect(reply.payload.verdict).toBe('approved');
    });

    it('should fail validation if message ID is missing', async () => {
      const request: any = {
        sender: 'software-engineer' as any,
        recipient: 'code-reviewer' as any,
        type: 'review-request',
        payload: {},
        timestamp: new Date().toISOString(),
      };
      await expect(messageRouter.send(request)).rejects.toThrow('Message ID is required.');
    });

    it('should fail validation if message sender is missing', async () => {
      const request: any = {
        id: crypto.randomUUID(),
        recipient: 'code-reviewer' as any,
        type: 'review-request',
        payload: {},
        timestamp: new Date().toISOString(),
      };
      await expect(messageRouter.send(request)).rejects.toThrow('Message sender is required.');
    });

    it('should fail validation if message recipient is missing', async () => {
      const request: any = {
        id: crypto.randomUUID(),
        sender: 'software-engineer' as any,
        type: 'review-request',
        payload: {},
        timestamp: new Date().toISOString(),
      };
      await expect(messageRouter.send(request)).rejects.toThrow('Message recipient is required.');
    });

    it('should fail validation if message type is missing', async () => {
      const request: any = {
        id: crypto.randomUUID(),
        sender: 'software-engineer' as any,
        recipient: 'code-reviewer' as any,
        payload: {},
        timestamp: new Date().toISOString(),
      };
      await expect(messageRouter.send(request)).rejects.toThrow('Message type is required.');
    });

    it('should fail validation if message timestamp is missing', async () => {
      const request: any = {
        id: crypto.randomUUID(),
        sender: 'software-engineer' as any,
        recipient: 'code-reviewer' as any,
        type: 'review-request',
        payload: {},
      };
      await expect(messageRouter.send(request)).rejects.toThrow('Message timestamp is required.');
    });

    it('should match reply correlationId with request ID as a standalone concern', async () => {
      const request: any = {
        id: 'req-uuid-12345',
        sender: 'software-engineer' as any,
        recipient: 'code-reviewer' as any,
        type: 'review-request',
        payload: {
          taskId: 't-1',
          description: 'Review mock write',
          filesChanged: [],
        },
        timestamp: new Date().toISOString(),
      };

      const reply = await messageRouter.sendAndReceive(request);
      expect(reply.correlationId).toBe('req-uuid-12345');
    });

    it('should throw error when routing to unregistered/nonexistent agent', async () => {
      const request: any = {
        id: crypto.randomUUID(),
        sender: 'software-engineer' as any,
        recipient: 'unknown-agent' as any,
        type: 'status-update',
        payload: {},
        timestamp: new Date().toISOString(),
      };

      await expect(messageRouter.send(request)).rejects.toThrow('unknown-agent');
    });

    it('should time out if recipient never responds', async () => {
      // Mock an agent that does not respond (returns null from receiveMessage)
      const silentAgent = {
        name: 'silent-agent',
        process: async () => ({ status: 'completed', filesChanged: [], explanation: '' } as any),
        receiveMessage: async () => null,
      };
      agentRouter.register(silentAgent);

      const request: any = {
        id: crypto.randomUUID(),
        sender: 'software-engineer' as any,
        recipient: 'silent-agent' as any,
        type: 'ping',
        payload: {},
        timestamp: new Date().toISOString(),
      };

      await expect(messageRouter.sendAndReceive(request)).rejects.toThrow('delivery timeout');
    });
  });

  describe('2. Message Loop & Cycle Detection', () => {
    it('should detect direct message loop and raise MessageLoopError', async () => {
      // Define a custom agent that returns a message back to the sender
      const looperAgent = {
        name: 'looper-agent',
        process: async () => ({ status: 'completed', filesChanged: [], explanation: '' } as any),
        receiveMessage: async (msg: any) => {
          // Send back to the sender
          return await messageRouter.send({
            id: crypto.randomUUID(),
            sender: 'looper-agent' as any,
            recipient: msg.sender,
            type: 'ping',
            payload: {},
            hops: msg.hops,
            timestamp: new Date().toISOString(),
          });
        },
      };
      agentRouter.register(looperAgent);

      const request: any = {
        id: crypto.randomUUID(),
        sender: 'software-engineer' as any,
        recipient: 'looper-agent' as any,
        type: 'ping',
        payload: {},
        timestamp: new Date().toISOString(),
      };

      // Since looper-agent calls messageRouter.send back to software-engineer,
      // and software-engineer is in message.hops, send should reject with MessageLoopError
      await expect(messageRouter.send(request)).rejects.toThrow(MessageLoopError);
    });

    it('should detect message loops across real production agents (CodeReviewer and ProjectManager) and throw MessageLoopError', async () => {
      const request: any = {
        id: crypto.randomUUID(),
        sender: 'project-manager' as any,
        recipient: 'code-reviewer' as any,
        type: 'review-request',
        payload: {
          taskId: 't-loop-test',
          description: 'Loop check with real agents',
          filesChanged: [],
        },
        timestamp: new Date().toISOString(),
        hops: ['project-manager'],
      };

      await expect(messageRouter.send(request)).rejects.toThrow(MessageLoopError);
    });
  });

  describe('3. Permission Escalation via Delegation Gating', () => {
    it('should ALLOW delegated file write if acting agent (software-engineer) allow-list permits it, recording delegation details in Audit Log', async () => {
      const filePath = path.join(tempDir, 'delegated_success.txt');
      const content = 'Delegated write content';

      // Researcher (who does NOT have write permissions) sends Software Engineer a write-file-request message
      const request: any = {
        id: crypto.randomUUID(),
        sender: 'researcher' as any,
        recipient: 'software-engineer' as any,
        type: 'write-file-request',
        payload: { path: filePath, content },
        timestamp: new Date().toISOString(),
      };

      const response = await messageRouter.sendAndReceive(request);
      expect(response.payload.success).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);

      // Verify Audit Log records both acting agent and originating agent in decision
      const recent = auditLog.recent();
      const writeDecision = recent.find((r) => r.event_type === 'decision' && r.action === 'file-write');
      expect(writeDecision).toBeDefined();
      expect(writeDecision?.actor).toBe('software-engineer'); // acting agent
      expect(writeDecision?.approval_status).toBe('granted');

      const params = JSON.parse(writeDecision?.params_json || '{}');
      expect(params.actingOnBehalfOf).toBe('researcher'); // originating agent
    });

    it('should BLOCK delegated file write if acting agent allow-list does not permit it (no escalation / reverse direction)', async () => {
      // Confirm via a new assertion that agentRouter.getAgent('researcher') is the real ResearcherAgent class instance before the test runs
      const activeResearcher = agentRouter.getAgent('researcher');
      expect(activeResearcher).toBeDefined();
      expect(activeResearcher instanceof ResearcherAgent).toBe(true);

      const request: any = {
        id: crypto.randomUUID(),
        sender: 'software-engineer' as any, // sender has permission
        recipient: 'researcher' as any, // recipient doesn't have permission
        type: 'write-file-request',
        payload: { path: path.join(tempDir, 'failed_delegation.txt'), content: 'fail' },
        timestamp: new Date().toISOString(),
      };

      const response = await messageRouter.sendAndReceive(request);
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toBe('permission-denied');
      expect(fs.existsSync(path.join(tempDir, 'failed_delegation.txt'))).toBe(false);

      // Verify Audit Log decision row shows researcher actor denied
      const recent = auditLog.recent();
      const writeDecision = recent.find(
        (r) => r.event_type === 'decision' && r.action === 'file-write' && r.actor === 'researcher'
      );
      expect(writeDecision).toBeDefined();
      expect(writeDecision?.approval_status).toBe('denied');
      expect(writeDecision?.approver).toBe('system');
    });
  });

  describe('4. Kanban Mutation Role Restriction', () => {
    it('should block non-Project Manager actor attempting Kanban database writes at Gatekeeper level', async () => {
      // Attempt card creation as 'software-engineer' actor
      await expect(
        kanbanConnector.createCard('software-engineer', {
          id: 'card-1',
          columnId: 'todo',
          title: 'Unauthorised Mutation',
          status: 'Todo',
        })
      ).rejects.toThrow('denied — not-permitted');

      // Verify the card was not created
      const cards = kanbanConnector.getCards();
      expect(cards.find(c => c.id === 'card-1')).toBeUndefined();

      // Verify decision/outcome registered in Audit Log
      const recent = auditLog.recent();
      const dec = recent.find((r) => r.event_type === 'decision' && r.action === 'kanban-write' && r.actor === 'software-engineer');
      const out = recent.find((r) => r.event_type === 'outcome' && r.action === 'kanban-write' && r.actor === 'software-engineer');

      expect(dec).toBeDefined();
      expect(dec?.approval_status).toBe('denied');
      expect(out).toBeDefined();
      expect(out?.outcome).toBe('denied — not-permitted');
    });

    it('should allow Project Manager actor to execute Kanban writes', async () => {
      await expect(
        kanbanConnector.createCard('project-manager', {
          id: 'card-pm-1',
          columnId: 'todo',
          title: 'Authorised Mutation',
          status: 'Todo',
        })
      ).resolves.not.toThrow();

      const cards = kanbanConnector.getCards();
      expect(cards.find(c => c.id === 'card-pm-1')).toBeDefined();
    });
  });

  describe('5. Full Swarm Integration Workflow & Sensible Task Reconciliation', () => {
    it('should execute full workflow: SoftwareEngineer finishes task -> CodeReviewer approves -> ProjectManager moves card to Done', async () => {
      // 1. Submit task
      const task = queue.enqueue({
        id: 'task-flow-1',
        description: 'Implement correct algorithm',
        priority: 1,
        fileContext: { targetPath: path.join(tempDir, 'code.js') },
      });

      // PM handles task:created via EventBus and creates a card in todo
      await new Promise(r => setTimeout(r, 50)); // yield for event loops
      const card = kanbanConnector.getCardByTaskId('task-flow-1');
      expect(card).toBeDefined();
      expect(card?.columnId).toBe('todo');

      // 2. Claim and process task
      const claimed = queue.claimNext(agentRouter);
      expect(claimed).not.toBeNull();
      expect(claimed?.id).toBe('task-flow-1');
      expect(claimed?.locked_by).toBe('software-engineer');

      eventBus.emit('task:started', { taskId: claimed!.id, agent: claimed!.locked_by! });
      // PM handles task:started and moves card to in-progress
      await new Promise(r => setTimeout(r, 50));
      const cardStarted = kanbanConnector.getCardByTaskId('task-flow-1');
      expect(cardStarted?.columnId).toBe('in-progress');

      // Process Software Engineer (which writes code.js and triggers code review request)
      const res = await softwareEngineer.process({
        taskId: 'task-flow-1',
        description: 'Implement correct algorithm',
        fileContext: { targetPath: path.join(tempDir, 'code.js') },
      });

      expect(res.status).toBe('completed');
      expect(fs.readFileSync(path.join(tempDir, 'code.js'), 'utf8')).toContain('function main');

      // The CodeReviewer automatically approves because we mocked modelRouter to approve,
      // which sends review-result approved message to PM.
      // PM moves card to done
      await new Promise(r => setTimeout(r, 100));
      const cardDone = kanbanConnector.getCardByTaskId('task-flow-1');
      expect(cardDone?.columnId).toBe('done');
      expect(cardDone?.status).toBe('Completed');
    });

    it('should execute failed review workflow: CodeReviewer requests changes -> PM moves card to In Progress & reconciles task in queue back to pending', async () => {
      // 1. Submit task with trigger to fail review
      const task = queue.enqueue({
        id: 'task-flow-fail',
        description: 'Implement correct algorithm (fail-review)',
        priority: 1,
        fileContext: { targetPath: path.join(tempDir, 'code_fail.js') },
      });

      // PM handles task:created
      await new Promise(r => setTimeout(r, 50));
      const card = kanbanConnector.getCardByTaskId('task-flow-fail');
      expect(card?.columnId).toBe('todo');

      // 2. Claim and process task
      const claimed = queue.claimNext(agentRouter);
      expect(claimed).not.toBeNull();
      expect(claimed?.locked_by).toBe('software-engineer');

      eventBus.emit('task:started', { taskId: claimed!.id, agent: claimed!.locked_by! });
      // Process SE
      const res = await softwareEngineer.process({
        taskId: 'task-flow-fail',
        description: 'Implement correct algorithm (fail-review)',
        fileContext: { targetPath: path.join(tempDir, 'code_fail.js') },
      });

      // The SE process call fails because review verdict was request-changes
      expect(res.status).toBe('failed');
      expect(res.explanation).toContain('Review rejected');

      // PM moves card to in-progress (status: Changes Requested)
      // PM resets task status in queue to 'pending'
      await new Promise(r => setTimeout(r, 100));
      const cardUpdated = kanbanConnector.getCardByTaskId('task-flow-fail');
      expect(cardUpdated?.columnId).toBe('in-progress');
      expect(cardUpdated?.status).toBe('Changes Requested');

      // Reconciled task queue check
      const taskInQueue = queue.getById('task-flow-fail');
      expect(taskInQueue?.status).toBe('pending');
      expect(taskInQueue?.error).toContain('Review rejected');
    });
  });

  describe('6. Empty Project Manager status report', () => {
    it('should return clean status report when no cards exist', async () => {
      const pmAgent = agentRouter.getAgent('project-manager') as ProjectManagerAgent;
      const res = await pmAgent.process({
        taskId: 'pm-status',
        description: 'Get status report',
      });
      expect(res.status).toBe('completed');
      expect(res.explanation).toContain('Kanban Board: Default Board');
      expect(res.explanation).toContain('[Todo] (0 cards)');
      expect(res.explanation).toContain('[In Progress] (0 cards)');
      expect(res.explanation).toContain('[Review] (0 cards)');
      expect(res.explanation).toContain('[Done] (0 cards)');
    });
  });
});
