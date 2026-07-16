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
  const queue = new TaskQueue(db, createLogger('task-queue', config.logLevel));
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

  const agentRouter = new AgentRouter();
  const softwareEngineer = new SoftwareEngineerAgent(
    modelRouter,
    gatekeeper,
    auditLog,
    createLogger('agent:software-engineer', config.logLevel)
  );
  agentRouter.register(softwareEngineer, { isDefault: true });

  const eventBus = new JarvisEventBus();

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
  };
}
