import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HealthMonitor } from '../src/lib/health.js';
import { bootstrap } from '../src/bootstrap.js';
import { denyAllPrompt } from '../src/permissions/gatekeeper.js';
import { createLogger } from '../src/lib/logger.js';

describe('Health Monitoring and Continuous-Operation Hardening tests', () => {
  let logger: any;
  let health: HealthMonitor;

  beforeEach(() => {
    logger = createLogger('test-health', 'silent');
    health = new HealthMonitor(logger);
  });

  it('should initialize all subsystems in START state', () => {
    const report = health.getReport();
    expect(report.length).toBe(8);
    for (const item of report) {
      expect(item.state).toBe('START');
      expect(item.restartCount).toBe(0);
    }
  });

  it('should transition subsystem states correctly', () => {
    health.transition('voice', 'HEALTHY');
    expect(health.getStatus('voice')?.state).toBe('HEALTHY');

    health.transition('voice', 'UNHEALTHY', 'Mic disconnected', 'Hardware failure');
    const status = health.getStatus('voice');
    expect(status?.state).toBe('UNHEALTHY');
    expect(status?.lastError).toBe('Mic disconnected');
    expect(status?.details).toBe('Hardware failure');
  });

  it('should honor restart limits and transition to FAILED', () => {
    // Perform restart attempts up to limits (default: 3)
    expect(health.canRestart('browser', true)).toBe(true);
    health.recordRestartAttempt('browser'); // Attempt 1
    
    expect(health.canRestart('browser', true)).toBe(true);
    health.recordRestartAttempt('browser'); // Attempt 2

    expect(health.canRestart('browser', true)).toBe(true);
    health.recordRestartAttempt('browser'); // Attempt 3

    // Next check should exceed limit and mark failed
    expect(health.canRestart('browser', true)).toBe(false);
    expect(health.getStatus('browser')?.state).toBe('FAILED');
  });

  it('should block rapid restarts based on backoff intervals', () => {
    health.recordRestartAttempt('terminal');
    
    // Immediate subsequent check should be blocked by backoff (default: 5000ms)
    const canRetry = health.canRestart('terminal');
    expect(canRetry).toBe(false);
  });

  it('should execute bootstrap shutdown idempotently multiple times', async () => {
    const ctx = bootstrap(denyAllPrompt, 'test-shutdown', false);
    
    // First shutdown should close SQLite db and terminate connectors
    await expect(ctx.shutdown()).resolves.not.toThrow();
    
    // Second shutdown call should exit early without throwing database closed exceptions
    await expect(ctx.shutdown()).resolves.not.toThrow();
  });
});
