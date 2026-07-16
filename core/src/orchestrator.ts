import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'pino';
import { TaskQueue } from './queue/index.js';
import { AgentRouter } from './router/agentRouter.js';
import { JarvisEventBus } from './events/bus.js';
import { toAgentInput } from '../../agents/shared/Agent.js';

export interface OrchestratorOptions {
  pollIntervalMs: number;
  staleTaskTimeoutMs: number;
  stopSignalPath: string;
}

/**
 * Computes the default emergency stop signal file location based on the database directory.
 *
 * @param dbPath Absolute or relative path to the SQLite file.
 * @returns An absolute path to the STOP file.
 */
export function defaultStopSignalPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'EMERGENCY_STOP');
}

export class Orchestrator {
  private queue: TaskQueue;
  private agentRouter: AgentRouter;
  private eventBus: JarvisEventBus;
  private logger: Logger;
  private options: OrchestratorOptions;

  private stopped = false;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    queue: TaskQueue,
    agentRouter: AgentRouter,
    eventBus: JarvisEventBus,
    logger: Logger,
    options: OrchestratorOptions
  ) {
    this.queue = queue;
    this.agentRouter = agentRouter;
    this.eventBus = eventBus;
    this.logger = logger;
    this.options = options;
  }

  /**
   * Starts the orchestrator polling daemon.
   */
  start(): void {
    this.stopped = false;
    this.logger.info(
      {
        pollIntervalMs: this.options.pollIntervalMs,
        staleTaskTimeoutMs: this.options.staleTaskTimeoutMs,
        stopSignalPath: this.options.stopSignalPath,
      },
      'Orchestrator daemon started.'
    );
    this.scheduleNext(0); // Starts immediately
  }

  /**
   * Shuts down the orchestrator daemon. Idempotent.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.eventBus.emit('queue:emergency-stop');
    this.logger.warn('Orchestrator daemon has been stopped.');
  }

  /**
   * Arms the setTimeout for the next poll execution.
   */
  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.poll().catch(err => {
        this.logger.error({ err }, 'Fatal unexpected error escaped poll loop.');
      });
    }, delayMs);
  }

  /**
   * Checks the environment, resolves worker availability, and processes queued items.
   */
  private async poll(): Promise<void> {
    if (this.stopped) return;

    // 1. Check emergency stop signal file
    if (fs.existsSync(this.options.stopSignalPath)) {
      this.logger.warn(
        { stopSignalPath: this.options.stopSignalPath },
        'Emergency stop signal file detected on disk. Stopping daemon immediately.'
      );
      this.stop();
      return;
    }

    // 2. Concurrency re-entrancy guard
    if (this.inFlight) {
      this.logger.debug('Orchestrator cycle skipped: preceding execution is still in-flight.');
      this.scheduleNext(this.options.pollIntervalMs);
      return;
    }

    this.inFlight = true;

    try {
      // 3. Scan and recover any stale tasks
      this.queue.recoverStaleTasks(this.options.staleTaskTimeoutMs);

      // 4. Resolve routing target agent
      const agent = this.agentRouter.resolve();

      // 5. Attempt claiming the next pending task
      const task = this.queue.claimNext(agent.name);
      if (!task) {
        // Queue is empty or blocked. Yield.
        this.inFlight = false;
        this.scheduleNext(this.options.pollIntervalMs);
        return;
      }

      // 6. Process the claimed task
      this.eventBus.emit('task:started', { taskId: task.id, agent: agent.name });

      // Start the task heartbeat loop
      const heartbeatIntervalMs = Math.max(1000, this.options.pollIntervalMs);
      const heartbeatInterval = setInterval(() => {
        try {
          this.queue.heartbeat(task.id);
        } catch (err) {
          this.logger.error({ err, taskId: task.id }, 'Task heartbeat update failed.');
        }
      }, heartbeatIntervalMs);

      try {
        const agentInput = toAgentInput(task);
        const result = await agent.process(agentInput);

        if (result.status === 'completed') {
          this.queue.complete(task.id, result);
          this.eventBus.emit('task:completed', { taskId: task.id });
        } else {
          const failRes = this.queue.fail(task.id, result.error ?? result.explanation);
          this.eventBus.emit('task:failed', {
            taskId: task.id,
            error: result.error ?? result.explanation,
            willRetry: failRes.willRetry,
          });
        }
      } catch (err: any) {
        // Contain exceptions thrown by the agent process
        const errMsg = err?.message || String(err);
        const failRes = this.queue.fail(task.id, errMsg);
        this.eventBus.emit('task:failed', {
          taskId: task.id,
          error: errMsg,
          willRetry: failRes.willRetry,
        });
      } finally {
        clearInterval(heartbeatInterval);
      }
    } catch (cycleError) {
      this.logger.error({ err: cycleError }, 'An unexpected exception occurred during the poll cycle.');
    } finally {
      this.inFlight = false;
      this.scheduleNext(this.options.pollIntervalMs);
    }
  }
}
