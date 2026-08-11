import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { loadConfig, Config } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { openDb } from './queue/db.js';
import { TaskQueue } from './queue/index.js';
import { AuditLog } from './permissions/auditLog.js';
import { PermissionGatekeeper, ApprovalPrompt } from './permissions/gatekeeper.js';
import { ModelRouter } from './router/modelRouter.js';
import { ClaudeConnector } from '../../connectors/claude-api/ClaudeConnector.js';
import { AgentRouter } from './router/agentRouter.js';
import { SoftwareEngineerAgent } from '../../agents/software-engineer/SoftwareEngineerAgent.js';
import { JarvisEventBus } from './events/bus.js';
import { SqliteVectorStore } from './memory/vectorStore.js';
import { LocalEmbeddingProvider } from './memory/embeddingProvider.js';
import { EmbeddingPipeline } from './memory/embeddingPipeline.js';
import { MemoryManager } from './memory/memoryManager.js';
import { KanbanConnector } from '../../connectors/kanban/KanbanConnector.js';
import { MessageRouter } from './router/messageRouter.js';
import { ResearcherAgent } from '../../agents/researcher/ResearcherAgent.js';
import { CodeReviewerAgent } from '../../agents/code-reviewer/CodeReviewerAgent.js';
import { ProjectManagerAgent } from '../../agents/project-manager/ProjectManagerAgent.js';
import { FilesystemConnector } from '../../connectors/filesystem/FilesystemConnector.js';
import { BrowserConnector } from '../../connectors/browser/BrowserConnector.js';
import { TerminalConnector } from '../../connectors/terminal/TerminalConnector.js';
import { BrowserOperatorAgent } from '../../agents/browser-operator/BrowserOperatorAgent.js';
import { TerminalOperatorAgent } from '../../agents/terminal-operator/TerminalOperatorAgent.js';

export interface CliContext {
  config: Config;
  logger: Logger;
  db: Database.Database;
  queue: TaskQueue;
  auditLog: AuditLog;
}

export interface JarvisContext extends CliContext {
  gatekeeper: PermissionGatekeeper;
  modelRouter: ModelRouter;
  agentRouter: AgentRouter;
  eventBus: JarvisEventBus;
  memoryManager: MemoryManager;
  messageRouter: MessageRouter;
  kanbanConnector: KanbanConnector;
  browserConnector?: BrowserConnector;
  terminalConnector?: TerminalConnector;
}

/**
 * Initializes a CLI context which does not check for ANTHROPIC_API_KEY presence,
 * enabling administrative queue or database maintenance tasks to execute.
 *
 * @param loggerName Identifies CLI logging categories (default: "jarvis-cli").
 */
export function openCliContext(loggerName = 'jarvis-cli'): CliContext {
  const config = loadConfig(false);
  const logger = createLogger(loggerName, config.logLevel);
  const db = openDb(config.dbPath);
  const queue = new TaskQueue(db, createLogger('task-queue', config.logLevel));
  const auditLog = new AuditLog(db);

  return {
    config,
    logger,
    db,
    queue,
    auditLog,
  };
}

/**
 * Bootstraps the full Jarvis runtime execution daemon.
 * Ensures the API key is present at startup, failing fast otherwise.
 *
 * @param approvalPrompt Interactive gating prompt used for human authorization.
 * @param loggerName Core system logging category (default: "jarvis").
 */
export function bootstrap(approvalPrompt: ApprovalPrompt, loggerName = 'jarvis'): JarvisContext {
  // Fail fast immediately at startup if ANTHROPIC_API_KEY is missing
  const config = loadConfig(true);

  const logger = createLogger(loggerName, config.logLevel);
  const db = openDb(config.dbPath);
  const eventBus = new JarvisEventBus();
  const queue = new TaskQueue(db, createLogger('task-queue', config.logLevel), eventBus);
  const auditLog = new AuditLog(db);

  const gatekeeper = new PermissionGatekeeper(
    auditLog,
    createLogger('gatekeeper', config.logLevel),
    approvalPrompt
  );

  const modelRouter = new ModelRouter();
  const claudeConnector = new ClaudeConnector({
    apiKey: config.anthropicApiKey!,
    model: config.model,
    maxRetries: config.maxRetries,
    logger: createLogger('claude-connector', config.logLevel),
  });
  modelRouter.register(claudeConnector);

  const vectorStore = new SqliteVectorStore(config.vectorStorePath, createLogger('vector-store', config.logLevel));
  const embeddingProvider = new LocalEmbeddingProvider(config.embeddingDimensions);
  const embeddingPipeline = new EmbeddingPipeline(vectorStore, embeddingProvider, createLogger('embedding-pipeline', config.logLevel));
  const memoryManager = new MemoryManager(
    db,
    vectorStore,
    embeddingPipeline,
    embeddingProvider,
    gatekeeper,
    auditLog,
    createLogger('memory-manager', config.logLevel),
    config
  );

  const agentRouter = new AgentRouter();
  const messageRouter = new MessageRouter(
    agentRouter,
    auditLog,
    createLogger('message-router', config.logLevel),
    10, // maxHops
    config.messageTimeoutMs ?? 10000
  );

  const filesystemConnector = new FilesystemConnector({
    projectRoot: config.projectRoot,
    gatekeeper,
    auditLog,
    logger: createLogger('filesystem-connector', config.logLevel),
  });

  const kanbanConnector = new KanbanConnector(
    db,
    gatekeeper,
    auditLog,
    createLogger('kanban-connector', config.logLevel),
    config.kanbanDefaultBoardId ?? 'default-board',
    config.kanbanDefaultBoardName ?? 'Default Board'
  );

  const browserConnector = new BrowserConnector({
    gatekeeper,
    auditLog,
    logger: createLogger('browser-connector', config.logLevel),
    headless: config.browserHeadless,
  });

  const terminalConnector = new TerminalConnector({
    projectRoot: config.projectRoot,
    gatekeeper,
    auditLog,
    logger: createLogger('terminal-connector', config.logLevel),
    timeoutMs: config.terminalTimeoutMs,
  });

  const softwareEngineer = new SoftwareEngineerAgent(
    modelRouter,
    gatekeeper,
    auditLog,
    memoryManager,
    createLogger('agent:software-engineer', config.logLevel),
    messageRouter
  );
  agentRouter.register(softwareEngineer, { isDefault: true });

  const researcher = new ResearcherAgent(
    modelRouter,
    filesystemConnector,
    memoryManager,
    createLogger('agent:researcher', config.logLevel),
    messageRouter
  );
  agentRouter.register(researcher);

  const codeReviewer = new CodeReviewerAgent(
    modelRouter,
    filesystemConnector,
    messageRouter,
    createLogger('agent:code-reviewer', config.logLevel)
  );
  agentRouter.register(codeReviewer);

  const projectManager = new ProjectManagerAgent(
    modelRouter,
    kanbanConnector,
    queue,
    messageRouter,
    createLogger('agent:project-manager', config.logLevel)
  );
  agentRouter.register(projectManager);

  const browserOperator = new BrowserOperatorAgent(
    modelRouter,
    browserConnector,
    memoryManager,
    createLogger('agent:browser-operator', config.logLevel),
    messageRouter
  );
  agentRouter.register(browserOperator);

  const terminalOperator = new TerminalOperatorAgent(
    modelRouter,
    terminalConnector,
    memoryManager,
    createLogger('agent:terminal-operator', config.logLevel),
    messageRouter
  );
  agentRouter.register(terminalOperator);

  // Subscribe Project Manager to event bus lifecycle events
  eventBus.on('task:created', (data) => {
    projectManager.handleTaskCreated(data).catch(err => {
      logger.error({ err }, 'Failed handling task:created event.');
    });
  });
  eventBus.on('task:started', (data) => {
    projectManager.handleTaskStarted(data).catch(err => {
      logger.error({ err }, 'Failed handling task:started event.');
    });
  });
  eventBus.on('task:completed', (data) => {
    projectManager.handleTaskCompleted(data).catch(err => {
      logger.error({ err }, 'Failed handling task:completed event.');
    });
  });
  eventBus.on('task:failed', (data) => {
    projectManager.handleTaskFailed(data).catch(err => {
      logger.error({ err }, 'Failed handling task:failed event.');
    });
  });

  // Emergency stop hook: make sure browser and terminal processes are killed cleanly
  eventBus.on('queue:emergency-stop', () => {
    browserConnector.close().catch(err => {
      logger.error({ err }, 'Failed to close browser connector during emergency stop.');
    });
    terminalConnector.killAll().catch(err => {
      logger.error({ err }, 'Failed to kill all terminal processes during emergency stop.');
    });
  });

  return {
    config,
    logger,
    db,
    queue,
    auditLog,
    gatekeeper,
    modelRouter,
    agentRouter,
    eventBus,
    memoryManager,
    messageRouter,
    kanbanConnector,
    browserConnector,
    terminalConnector,
  };
}
