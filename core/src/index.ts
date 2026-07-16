import { ConfigError } from './lib/config.js';
import { bootstrap } from './bootstrap.js';
import { createStdinApprovalPrompt } from './lib/prompt.js';
import { Orchestrator, defaultStopSignalPath } from './orchestrator.js';

let orchestrator: Orchestrator | null = null;
let dbInstance: any = null;

try {
  // Bootstrap the Jarvis OS daemon context
  const ctx = bootstrap(createStdinApprovalPrompt(), 'jarvis-core');
  dbInstance = ctx.db;

  const stopSignalPath = defaultStopSignalPath(ctx.config.dbPath);

  orchestrator = new Orchestrator(
    ctx.queue,
    ctx.agentRouter,
    ctx.eventBus,
    ctx.logger,
    {
      pollIntervalMs: ctx.config.pollIntervalMs,
      staleTaskTimeoutMs: ctx.config.staleTaskTimeoutMs,
      stopSignalPath,
    }
  );

  orchestrator.start();
} catch (error) {
  if (error instanceof ConfigError) {
    // Print clear configuration errors directly to stderr at startup
    process.stderr.write(`FATAL: ${error.message}\n`);
    process.exit(1);
  }
  // Let unexpected bootstrapping errors throw standard stack traces
  throw error;
}

// Clean shutdown signal listeners
function handleShutdown(signal: string): void {
  if (orchestrator) {
    orchestrator.stop();
  }
  if (dbInstance && dbInstance.open) {
    dbInstance.close();
  }
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
