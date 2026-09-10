import { Logger } from 'pino';
import { loadConfig } from './config.js';

export type SubsystemName = 'core' | 'voice' | 'vision' | 'persistence' | 'browser' | 'terminal' | 'desktop' | 'override';
export type SubsystemState = 'START' | 'HEALTHY' | 'UNHEALTHY' | 'STOPPING' | 'STOPPED' | 'RESTARTING' | 'FAILED';

export interface SubsystemStatus {
  name: SubsystemName;
  state: SubsystemState;
  restartCount: number;
  lastRestartAttempt?: string;
  lastError?: string;
  details?: string;
}

export class HealthMonitor {
  private logger: Logger;
  private statuses = new Map<SubsystemName, SubsystemStatus>();

  constructor(logger: Logger) {
    this.logger = logger;
    const list: SubsystemName[] = ['core', 'voice', 'vision', 'persistence', 'browser', 'terminal', 'desktop', 'override'];
    for (const name of list) {
      this.statuses.set(name, {
        name,
        state: 'START',
        restartCount: 0,
      });
    }
  }

  /**
   * Transitions a subsystem to a new state and logs the diagnostic event.
   */
  transition(name: SubsystemName, state: SubsystemState, error?: string, details?: string): void {
    const status = this.statuses.get(name);
    if (!status) return;

    const oldState = status.state;
    status.state = state;
    if (error) status.lastError = error;
    if (details) status.details = details;

    this.logger.info(
      { subsystem: name, oldState, newState: state, restartCount: status.restartCount, error, details },
      `Subsystem ${name} transitioned from ${oldState} to ${state}`
    );
  }

  canRestart(name: SubsystemName, bypassBackoff = false): boolean {
    const config = loadConfig(false);
    const status = this.statuses.get(name);
    if (!status) return false;

    if (status.state === 'FAILED') {
      return false;
    }

    if (status.restartCount >= config.restartLimits) {
      this.transition(name, 'FAILED', `Restart limit of ${config.restartLimits} attempts reached.`);
      return false;
    }

    if (!bypassBackoff && status.lastRestartAttempt) {
      const lastAttemptTime = new Date(status.lastRestartAttempt).getTime();
      const elapsed = Date.now() - lastAttemptTime;
      if (elapsed < config.restartBackoffMs) {
        this.logger.debug(
          { subsystem: name, elapsedMs: elapsed, backoffMs: config.restartBackoffMs },
          `Restart request throttled by backoff rules.`
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Records a restart attempt for a subsystem, incrementing its restart counter.
   */
  recordRestartAttempt(name: SubsystemName): void {
    const status = this.statuses.get(name);
    if (!status) return;

    status.restartCount++;
    status.lastRestartAttempt = new Date().toISOString();
    this.transition(name, 'RESTARTING', undefined, `Restart attempt #${status.restartCount}`);
  }

  /**
   * Resets the restart counter of a subsystem (e.g. after a recovery is confirmed).
   */
  resetRestartCount(name: SubsystemName): void {
    const status = this.statuses.get(name);
    if (!status) return;

    status.restartCount = 0;
  }

  /**
   * Returns a copy of the status structure of all monitored subsystems.
   */
  getReport(): SubsystemStatus[] {
    return Array.from(this.statuses.values()).map((val) => ({ ...val }));
  }

  /**
   * Convenience lookup for a single subsystem status.
   */
  getStatus(name: SubsystemName): SubsystemStatus | undefined {
    const val = this.statuses.get(name);
    return val ? { ...val } : undefined;
  }
}
