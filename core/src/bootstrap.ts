import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { loadConfig, Config } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { openDb } from './queue/db.js';
import { TaskQueue } from './queue/index.js';
import { AuditLog } from './permissions/auditLog.js';
import { PermissionGatekeeper, ApprovalPrompt } from './permissions/gatekeeper.js';
import { ModelRouter } from './router/modelRouter.js';
import { OllamaConnector } from '../../connectors/ollama/OllamaConnector.js';
import { AgentRouter } from './router/agentRouter.js';
import { SoftwareEngineerAgent } from '../../agents/software-engineer/SoftwareEngineerAgent.js';
import { JarvisEventBus } from './events/bus.js';
import { SqliteVectorStore } from './memory/vectorStore.js';
import { LocalEmbeddingProvider } from './memory/embeddingProvider.js';
import { EmbeddingPipeline } from './memory/embeddingPipeline.js';
import { MemoryManager } from './memory/memoryManager.js';
import { TrayManager } from '../../services/TrayManager.js';
import { ClaudeConnector } from '../../connectors/claude-api/ClaudeConnector.js';
import { PeriodicCaptureManager } from '../../services/PeriodicCaptureManager.js';
import { SearchConnector } from '../../connectors/search/SearchConnector.js';
import { KanbanConnector } from '../../connectors/kanban/KanbanConnector.js';
import { DuplexAudioServer } from './voice/DuplexAudioServer.js';
import { MessageRouter } from './router/messageRouter.js';
import { ResearcherAgent } from '../../agents/researcher/ResearcherAgent.js';
import { CodeReviewerAgent } from '../../agents/code-reviewer/CodeReviewerAgent.js';
import { ProjectManagerAgent } from '../../agents/project-manager/ProjectManagerAgent.js';
import { FilesystemConnector } from '../../connectors/filesystem/FilesystemConnector.js';
import { BrowserConnector } from '../../connectors/browser/BrowserConnector.js';
import { TerminalConnector } from '../../connectors/terminal/TerminalConnector.js';
import { BrowserOperatorAgent } from '../../agents/browser-operator/BrowserOperatorAgent.js';
import { TerminalOperatorAgent } from '../../agents/terminal-operator/TerminalOperatorAgent.js';
import { ComputerVisionConnector } from '../../connectors/vision/ComputerVisionConnector.js';
import { DesktopConnector } from '../../connectors/desktop/DesktopConnector.js';
import { OverrideHookConnector } from '../../connectors/override/OverrideHookConnector.js';
import { HealthMonitor } from './lib/health.js';
import { WorkspaceManager } from './workspace/WorkspaceManager.js';

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
  browserConnector: BrowserConnector;
  terminalConnector: TerminalConnector;
  computerVisionConnector: ComputerVisionConnector;
  periodicCaptureManager: PeriodicCaptureManager;
  searchConnector: SearchConnector;
  duplexAudioServer: DuplexAudioServer;
  desktopConnector: DesktopConnector;
  overrideHookConnector: OverrideHookConnector;
  healthMonitor: HealthMonitor;
  workspaceManager: WorkspaceManager;
  shutdown: () => Promise<void>;
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
export function bootstrap(approvalPrompt: ApprovalPrompt, loggerName = 'jarvis', requireApiKey = false): JarvisContext {
  // Fail fast immediately at startup if ANTHROPIC_API_KEY is missing
  const config = loadConfig(requireApiKey);

  const logger = createLogger(loggerName, config.logLevel);
  const healthMonitor = new HealthMonitor(createLogger('health-monitor', config.logLevel));
  
  healthMonitor.transition('core', 'START');

  const db = openDb(config.dbPath);
  try {
    db.prepare('SELECT 1').get();
    healthMonitor.transition('persistence', 'HEALTHY');
  } catch (err: any) {
    healthMonitor.transition('persistence', 'UNHEALTHY', err.message);
  }

  const eventBus = new JarvisEventBus();
  const queue = new TaskQueue(db, createLogger('task-queue', config.logLevel), eventBus);
  const auditLog = new AuditLog(db);

  const gatekeeper = new PermissionGatekeeper(
    auditLog,
    createLogger('gatekeeper', config.logLevel),
    approvalPrompt
  );

  const modelRouter = new ModelRouter();
  const ollamaConnector = new OllamaConnector({
    model: process.env.JARVIS_OLLAMA_MODEL ?? 'llava:latest',
    baseUrl: process.env.JARVIS_OLLAMA_BASE_URL ?? 'http://localhost:11434',
    maxRetries: config.maxRetries,
    timeoutMs: config.claudeTimeoutMs,
    logger: createLogger('ollama-connector', config.logLevel),
  });
  modelRouter.register(ollamaConnector);

  if (config.anthropicApiKey) {
    const claudeConnector = new ClaudeConnector({
      apiKey: config.anthropicApiKey,
      model: config.model || 'claude-3-5-sonnet-20240620',
      maxRetries: config.maxRetries,
      timeoutMs: config.claudeTimeoutMs,
      logger: createLogger('claude-connector', config.logLevel),
    });
    modelRouter.register(claudeConnector);
  }

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

  const workspaceManager = new WorkspaceManager(db, createLogger('workspace-manager', config.logLevel));

  // If an active workspace is set, use its root for filesystem/terminal scoping
  const activeWorkspace = workspaceManager.getActiveWorkspace();
  const effectiveProjectRoot = activeWorkspace ? activeWorkspace.rootPath : config.projectRoot;

  const workspaceScopedFilesystem = activeWorkspace
    ? new FilesystemConnector({
        projectRoot: effectiveProjectRoot,
        gatekeeper,
        auditLog,
        logger: createLogger('filesystem-connector', config.logLevel),
      })
    : filesystemConnector;

  const boardId = activeWorkspace
    ? `board-${activeWorkspace.id.slice(0, 8)}`
    : (config.kanbanDefaultBoardId ?? 'default-board');
  const boardName = activeWorkspace
    ? `Board for ${activeWorkspace.name}`
    : (config.kanbanDefaultBoardName ?? 'Default Board');

  const kanbanConnector = new KanbanConnector(
    db,
    gatekeeper,
    auditLog,
    createLogger('kanban-connector', config.logLevel),
    boardId,
    boardName,
    activeWorkspace ? activeWorkspace.id : null
  );

  const browserConnector = new BrowserConnector({
    gatekeeper,
    auditLog,
    logger: createLogger('browser-connector', config.logLevel),
    headless: config.browserHeadless,
  });

  const terminalConnector = new TerminalConnector({
    projectRoot: effectiveProjectRoot,
    gatekeeper,
    auditLog,
    logger: createLogger('terminal-connector', config.logLevel),
    timeoutMs: config.terminalTimeoutMs,
  });

  const computerVisionConnector = new ComputerVisionConnector({
    gatekeeper,
    auditLog,
    modelRouter,
    logger: createLogger('vision-connector', config.logLevel),
  });

  const periodicCaptureManager = new PeriodicCaptureManager({
    computerVisionConnector,
    gatekeeper,
    eventBus,
    memoryManager,
    modelRouter,
    logger: createLogger('periodic-capture', config.logLevel),
    healthMonitor,
    intervalMs: config.visionPeriodicIntervalMs,
    retentionMax: config.visionPeriodicRetentionMax,
  });

  const overrideHookConnector = new OverrideHookConnector({
    eventBus,
    logger: createLogger('override-hook-connector', config.logLevel),
  });

  const desktopConnector = new DesktopConnector({
    gatekeeper,
    auditLog,
    visionConnector: computerVisionConnector,
    overrideHookConnector,
    logger: createLogger('desktop-connector', config.logLevel),
  });

  const duplexAudioServer = new DuplexAudioServer({
    config,
    logger: createLogger('duplex-audio-server', config.logLevel),
    modelRouter,
    healthMonitor,
  });

  // Only start the duplex voice server in production, not in Vitest test runs to avoid port collision
  if (!process.env.VITEST) {
    duplexAudioServer.start();
  }

  healthMonitor.transition('browser', 'HEALTHY');
  healthMonitor.transition('terminal', 'HEALTHY');
  healthMonitor.transition('vision', 'HEALTHY');
  healthMonitor.transition('desktop', 'HEALTHY');
  healthMonitor.transition('voice', 'HEALTHY');
  
  overrideHookConnector.start()
    .then(() => {
      const current = healthMonitor.getStatus('override')?.state;
      if (current !== 'STOPPED' && current !== 'STOPPING') {
        healthMonitor.transition('override', 'HEALTHY');
      }
    })
    .catch(err => {
      const current = healthMonitor.getStatus('override')?.state;
      if (current !== 'STOPPED' && current !== 'STOPPING') {
        healthMonitor.transition('override', 'FAILED', err.message);
      }
    });

  healthMonitor.transition('core', 'HEALTHY');

  const softwareEngineer = new SoftwareEngineerAgent(
    modelRouter,
    gatekeeper,
    auditLog,
    memoryManager,
    createLogger('agent:software-engineer', config.logLevel),
    messageRouter
  );
  agentRouter.register(softwareEngineer, { isDefault: true });

  const searchConnector = new SearchConnector({
    provider: config.searchProvider as 'tavily' | 'duckduckgo',
    apiKey: config.searchApiKey,
    gatekeeper,
    auditLog,
    db,
    logger: createLogger('search-connector', config.logLevel),
    rateLimitCount: config.searchRateLimitCount,
    rateLimitWindowMs: config.searchRateLimitWindowMs,
  });

  const researcher = new ResearcherAgent(
    modelRouter,
    workspaceScopedFilesystem,
    memoryManager,
    createLogger('agent:researcher', config.logLevel),
    messageRouter,
    gatekeeper,
    auditLog,
    computerVisionConnector,
    searchConnector
  );
  agentRouter.register(researcher);

  const codeReviewer = new CodeReviewerAgent(
    modelRouter,
    workspaceScopedFilesystem,
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
    browserConnector.close(data.taskId).catch(err => {
      logger.error({ err }, 'Failed to close browser session for completed task.');
    });
  });
  eventBus.on('task:failed', (data) => {
    projectManager.handleTaskFailed(data).catch(err => {
      logger.error({ err }, 'Failed handling task:failed event.');
    });
    browserConnector.close(data.taskId).catch(err => {
      logger.error({ err }, 'Failed to close browser session for failed task.');
    });
  });

  // Emergency stop hook: make sure browser and terminal processes are killed cleanly
  eventBus.on('queue:emergency-stop', () => {
    try {
      desktopConnector.emergencyStop();
    } catch (err: any) {
      logger.error({ err }, 'Failed to stop desktop connector during emergency stop.');
    }
    browserConnector.close().catch(err => {
      logger.error({ err }, 'Failed to close browser connector during emergency stop.');
    });
    terminalConnector.killAll().catch(err => {
      logger.error({ err }, 'Failed to kill all terminal processes during emergency stop.');
    });
  });

  let shutdownInProgress = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    
    logger.warn('Graceful shutdown starting...');
    healthMonitor.transition('core', 'STOPPING');

    // Emit event bus emergency stop first (stops queue polling)
    try {
      eventBus.emit('queue:emergency-stop');
    } catch (err: any) {
      logger.error({ err }, 'Error emitting queue:emergency-stop');
    }

    // Terminate browser sessions
    healthMonitor.transition('browser', 'STOPPING');
    try {
      await browserConnector.close();
      healthMonitor.transition('browser', 'STOPPED');
    } catch (err: any) {
      healthMonitor.transition('browser', 'FAILED', err.message);
    }

    // Terminate periodic screenshot captures
    try {
      periodicCaptureManager.stop();
    } catch (err: any) {
      logger.error({ err }, 'Failed to stop periodic capture manager during shutdown.');
    }

    // Terminate duplex WebSocket audio server
    try {
      duplexAudioServer.stop();
    } catch (err: any) {
      logger.error({ err }, 'Failed to stop duplex audio server during shutdown.');
    }

    // Terminate desktop sessions
    healthMonitor.transition('desktop', 'STOPPING');
    try {
      desktopConnector.resetActionCount();
      healthMonitor.transition('desktop', 'STOPPED');
    } catch (err: any) {
      healthMonitor.transition('desktop', 'FAILED', err.message);
    }

    // Terminate override hooks
    healthMonitor.transition('override', 'STOPPING');
    try {
      await overrideHookConnector.stop();
      healthMonitor.transition('override', 'STOPPED');
    } catch (err: any) {
      healthMonitor.transition('override', 'FAILED', err.message);
    }

    // Terminate active terminal shells
    healthMonitor.transition('terminal', 'STOPPING');
    try {
      await terminalConnector.killAll();
      healthMonitor.transition('terminal', 'STOPPED');
    } catch (err: any) {
      healthMonitor.transition('terminal', 'FAILED', err.message);
    }

    // Close SQLite primary database
    healthMonitor.transition('persistence', 'STOPPING');
    try {
      if (db && db.open) {
        db.close();
      }
      healthMonitor.transition('persistence', 'STOPPED');
    } catch (err: any) {
      healthMonitor.transition('persistence', 'FAILED', err.message);
    }

    healthMonitor.transition('core', 'STOPPED');
    logger.warn('Graceful shutdown completed.');
  };

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
    computerVisionConnector,
    periodicCaptureManager,
    searchConnector,
    duplexAudioServer,
    desktopConnector,
    overrideHookConnector,
    healthMonitor,
    workspaceManager,
    shutdown,
  };
}
