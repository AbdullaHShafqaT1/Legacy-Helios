import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'pino';
import { ComputerVisionConnector } from '../connectors/vision/ComputerVisionConnector.js';
import { PermissionGatekeeper } from '../core/src/permissions/gatekeeper.js';
import { JarvisEventBus } from '../core/src/events/bus.js';
import { MemoryManager } from '../core/src/memory/memoryManager.js';
import { ModelRouter } from '../core/src/router/modelRouter.js';
import { redactSecrets } from '../core/src/lib/redact.js';
import { HealthMonitor } from '../core/src/lib/health.js';
import { AgentRole } from '../core/src/permissions/policy.js';

export interface PeriodicCaptureOptions {
  computerVisionConnector: ComputerVisionConnector;
  gatekeeper: PermissionGatekeeper;
  eventBus: JarvisEventBus;
  memoryManager: MemoryManager;
  modelRouter: ModelRouter;
  logger: Logger;
  healthMonitor?: HealthMonitor;
  intervalMs?: number;
  retentionMax?: number;
  provider?: 'ollama' | 'claude';
}

export class PeriodicCaptureManager {
  private cvConnector: ComputerVisionConnector;
  private gatekeeper: PermissionGatekeeper;
  private eventBus: JarvisEventBus;
  private memoryManager: MemoryManager;
  private modelRouter: ModelRouter;
  private logger: Logger;
  private healthMonitor?: HealthMonitor;
  private intervalMs: number;
  private retentionMax: number;
  private provider: 'ollama' | 'claude';

  private timer: NodeJS.Timeout | null = null;
  private isCapturing = false;
  private actor: AgentRole = 'researcher';
  private capturedPaths: string[] = [];

  constructor(options: PeriodicCaptureOptions) {
    this.cvConnector = options.computerVisionConnector;
    this.gatekeeper = options.gatekeeper;
    this.eventBus = options.eventBus;
    this.memoryManager = options.memoryManager;
    this.modelRouter = options.modelRouter;
    this.logger = options.logger;
    this.healthMonitor = options.healthMonitor;
    this.intervalMs = options.intervalMs ?? 10000;
    this.retentionMax = options.retentionMax ?? 15;
    this.provider = options.provider ?? 'ollama';

    // Emergency stop trigger setup
    this.eventBus.on('queue:emergency-stop', () => {
      if (this.isCapturing) {
        this.logger.warn('Periodic screenshot capture halting immediately due to emergency-stop.');
        this.stop();
      }
    });
  }

  /**
   * Starts the background periodic screenshot capturing.
   * Gated by the explicit separate action category 'vision-periodic-start'.
   */
  async start(actor: AgentRole): Promise<boolean> {
    if (this.isCapturing) return true;
    this.actor = actor;

    this.logger.info({ actor, action: 'vision-periodic-start' }, 'Requesting authorization for periodic screenshot capture');
    const auth = await this.gatekeeper.authorize({
      actor,
      action: 'vision-periodic-start',
      params: {
        intervalMs: this.intervalMs,
        retentionMax: this.retentionMax,
        provider: this.provider,
      },
    });

    if (!auth.granted) {
      this.logger.warn('Periodic screenshot capture authorization denied.');
      return false;
    }

    this.isCapturing = true;
    if (this.healthMonitor) {
      this.healthMonitor.transition('vision', 'HEALTHY', undefined, 'periodic-capture: active');
    }

    this.logger.info({ intervalMs: this.intervalMs }, 'Periodic screenshot capture active.');
    this.scheduleNextTick();
    return true;
  }

  /**
   * Stops the capture loop and updates status flags.
   */
  stop(): void {
    this.isCapturing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.healthMonitor) {
      this.healthMonitor.transition('vision', 'HEALTHY', undefined, 'periodic-capture: idle');
    }
    this.logger.info('Periodic screenshot capture stopped.');
  }

  isActive(): boolean {
    return this.isCapturing;
  }

  getCapturedPaths(): string[] {
    return [...this.capturedPaths];
  }

  private scheduleNextTick(): void {
    if (!this.isCapturing) return;

    this.timer = setTimeout(() => {
      this.tick()
        .catch(err => {
          this.logger.error({ err: err?.message || err }, 'Error in periodic capture tick');
        })
        .finally(() => {
          this.scheduleNextTick();
        });
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.isCapturing) return;

    try {
      this.logger.debug('Periodic capture tick running...');
      const observation = await this.cvConnector.captureScreen(this.actor);
      
      if (!observation.success || !observation.screenshotPath) {
        this.logger.error({ error: observation.error }, 'Periodic capture failed to acquire screenshot. Terminating capture loop.');
        this.stop();
        return;
      }

      // Add to FIFO path retention cache
      this.capturedPaths.push(observation.screenshotPath);
      this.enforceRetention();

      // Convert file to base64 for LLM vision analysis
      const base64Data = fs.readFileSync(observation.screenshotPath).toString('base64');

      this.logger.debug({ provider: this.provider }, 'Sending periodic capture screenshot for vision analysis');
      const response = await this.modelRouter.route('vision', {
        description: 'Describe any visual changes or activities visible on this screen. Extract relevant text summaries if any.',
        image: {
          base64: base64Data,
          mediaType: 'image/png',
        },
        provider: this.provider,
      });

      // Best-effort redaction before storing screen details in Memory
      const rawText = response.text || '';
      const redactedText = redactSecrets(rawText) as string;

      this.logger.info('Storing visual screenshot details in Memory Manager.');
      await this.memoryManager.store({
        content: `Periodic screen visual state: ${redactedText}`,
        sourceAgent: 'system',
        sourceTaskId: 'periodic-snapshot',
        tag: 'periodic-snapshot',
      });

    } catch (err: any) {
      this.logger.error({ err: err?.message || err }, 'Periodic snapshot loop tick failed. Terminating capture loop.');
      this.stop();
    }
  }

  /** Keeps the files count within retention limits (FIFO) */
  private enforceRetention(): void {
    while (this.capturedPaths.length > this.retentionMax) {
      const oldestPath = this.capturedPaths.shift();
      if (oldestPath && oldestPath !== path.resolve('core/test/fixtures/desktop_screenshot.png')) {
        try {
          if (fs.existsSync(oldestPath)) {
            fs.unlinkSync(oldestPath);
            this.logger.debug({ path: oldestPath }, 'Purged old periodic screenshot file due to FIFO retention policy');
          }
        } catch (err: any) {
          this.logger.error({ err: err?.message || err, path: oldestPath }, 'Failed to delete expired periodic screenshot file');
        }
      }
    }
  }
}
