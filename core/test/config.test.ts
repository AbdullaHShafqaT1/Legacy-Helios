import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, clearConfigCache, ConfigError } from '../src/lib/config.js';

describe('Configuration Loader', () => {
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    // Backup process.env
    envBackup = { ...process.env };
    // Clear cache to allow re-reading environment variables per test
    clearConfigCache();
    // Clear out env keys under test
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.JARVIS_DB_PATH;
    delete process.env.JARVIS_MODEL;
    delete process.env.JARVIS_MAX_RETRIES;
    delete process.env.JARVIS_POLL_INTERVAL_MS;
    delete process.env.JARVIS_STALE_TASK_TIMEOUT_MS;
    delete process.env.JARVIS_LOG_LEVEL;
  });

  afterEach(() => {
    // Restore process.env
    process.env = envBackup;
    clearConfigCache();
  });

  it('should throw ConfigError if ANTHROPIC_API_KEY is missing and requireApiKey is true (default)', () => {
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig(true)).toThrow(ConfigError);
  });

  it('should throw ConfigError if ANTHROPIC_API_KEY is empty whitespace and requireApiKey is true', () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    expect(() => loadConfig(true)).toThrow(ConfigError);
  });

  it('should not throw if ANTHROPIC_API_KEY is missing and requireApiKey is false', () => {
    expect(() => loadConfig(false)).not.toThrow();
    const config = loadConfig(false);
    expect(config.anthropicApiKey).toBeUndefined();
  });

  it('should apply documented defaults for optional variables', () => {
    const config = loadConfig(false);
    expect(config.dbPath).toBe('memory-store/jarvis.db');
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.maxRetries).toBe(3);
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.staleTaskTimeoutMs).toBe(300000);
    expect(config.logLevel).toBe('info');
  });

  it('should parse optional variables correctly when provided', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.JARVIS_DB_PATH = 'custom/path.db';
    process.env.JARVIS_MODEL = 'claude-3-opus-20240229';
    process.env.JARVIS_MAX_RETRIES = '5';
    process.env.JARVIS_POLL_INTERVAL_MS = '1000';
    process.env.JARVIS_STALE_TASK_TIMEOUT_MS = '60000';
    process.env.JARVIS_LOG_LEVEL = 'debug';

    const config = loadConfig(true);
    expect(config.anthropicApiKey).toBe('sk-ant-test-key');
    expect(config.dbPath).toBe('custom/path.db');
    expect(config.model).toBe('claude-3-opus-20240229');
    expect(config.maxRetries).toBe(5);
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.staleTaskTimeoutMs).toBe(60000);
    expect(config.logLevel).toBe('debug');
  });

  it('should throw ConfigError if numeric variables are invalid numbers', () => {
    process.env.JARVIS_MAX_RETRIES = 'not-a-number';
    expect(() => loadConfig(false)).toThrow(ConfigError);
  });

  it('should cache the loaded configuration and not re-read process.env', () => {
    process.env.ANTHROPIC_API_KEY = 'first-key';
    const config1 = loadConfig(true);

    // Change environment variable
    process.env.ANTHROPIC_API_KEY = 'second-key';
    const config2 = loadConfig(true);

    // Should return cached first key
    expect(config2.anthropicApiKey).toBe('first-key');
    expect(config1).toBe(config2);
  });
});
