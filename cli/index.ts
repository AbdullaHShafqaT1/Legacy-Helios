import { loadConfig } from '../core/src/lib/config.js';
import { createLogger } from '../core/src/lib/logger.js';

const log = createLogger('cli-startup');

try {
  log.info('Starting Jarvis CLI Interface (Phase 1)...');
  const config = loadConfig(false);
  log.info({
    dbPath: config.dbPath,
    logLevel: config.logLevel
  }, 'Jarvis CLI configuration verified');
} catch (error) {
  log.error({ error }, 'Jarvis CLI startup failed due to configuration error');
  process.exit(1);
}
