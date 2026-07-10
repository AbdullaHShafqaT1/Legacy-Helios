import { loadConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('core-startup');

try {
  log.info('Starting Jarvis Core Engine (Phase 1)...');
  // Load configuration with requireApiKey = false for scaffolding/testing startup.
  const config = loadConfig(false);
  log.info({ 
    config: {
      ...config,
      anthropicApiKey: config.anthropicApiKey ? '[PRESENT]' : undefined
    }
  }, 'Jarvis Configuration loaded successfully');
} catch (error) {
  log.error({ error }, 'Jarvis core engine startup failed due to configuration error');
  process.exit(1);
}
