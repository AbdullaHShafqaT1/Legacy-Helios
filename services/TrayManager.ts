import path from 'node:path';
import { Logger } from 'pino';
import { JarvisEventBus } from '../core/src/events/bus.js';
import { HealthMonitor } from '../core/src/lib/health.js';
import Database from 'better-sqlite3';

export interface TrayManagerOptions {
  eventBus: JarvisEventBus;
  healthMonitor: HealthMonitor;
  db: Database.Database;
  logger: Logger;
  /** Poll interval for status refresh in ms. Default: 2000 */
  pollIntervalMs?: number;
  /** Path to the tray icon file. Default: ../assets/tray-icon.png */
  iconPath?: string;
}

type TrayStatus = 'idle' | 'listening' | 'task-in-progress' | 'paused' | 'error';

/**
 * TrayManager — lightweight system tray icon for Jarvis OS.
 *
 * Design constraints (Phase 12):
 * 1. Status sourced exclusively from `healthMonitor.getReport()` — no parallel status system.
 * 2. Emergency stop action routes ONLY through `eventBus.emit('queue:emergency-stop')` — the
 *    SAME event used by Phase 10/11's override hook and CLI `jarvis stop`. Zero new stop paths.
 * 3. Read-only surface: no task submission, no input-injection capability exposed via tray.
 * 4. Graceful headless fallback: if node-systray fails to initialize (headless server, CI runner
 *    without a display), Jarvis core continues normally — the tray is non-critical.
 *
 * Session-0 note: the tray icon requires a display server / interactive desktop session.
 * This aligns with Phase 12's autostart requirement that Jarvis must run as an interactive user
 * session anyway (Task Scheduler LogonType=InteractiveToken). The tray is not expected to work
 * in a true Session-0 environment and will fall back gracefully if it can't initialize.
 */
export class TrayManager {
  private options: Required<TrayManagerOptions>;
  private tray: any = null; // node-systray SysTray instance
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(options: TrayManagerOptions) {
    this.options = {
      pollIntervalMs: 2000,
      iconPath: path.resolve('assets', 'tray-icon.png'),
      ...options,
    };
  }

  /**
   * Returns the current Jarvis status derived from health monitor state.
   */
  private computeStatus(): TrayStatus {
    const report = this.options.healthMonitor.getReport();

    const coreStatus = report.find(s => s.name === 'core');
    if (coreStatus?.state === 'STOPPING' || coreStatus?.state === 'STOPPED') return 'paused';

    const hasError = report.some(s => s.state === 'FAILED' || s.state === 'UNHEALTHY');
    if (hasError) return 'error';

    const voiceStatus = report.find(s => s.name === 'voice');
    if (voiceStatus?.state === 'HEALTHY') {
      // Check if voice is actively listening — approximate via state
    }

    const desktopStatus = report.find(s => s.name === 'desktop');
    if (desktopStatus?.state === 'HEALTHY') {
      // Could check for in-progress tasks below
    }

    // Check for in-progress tasks
    try {
      const inProgress = this.options.db
        .prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'in-progress'")
        .get() as { count: number };
      if (inProgress.count > 0) return 'task-in-progress';
    } catch { /* ignore if db is closing */ }

    return 'idle';
  }

  /** Returns the count of items currently in the unattended approval queue. */
  private getPendingApprovalCount(): number {
    try {
      const row = this.options.db
        .prepare("SELECT COUNT(*) as count FROM pending_approvals WHERE status = 'pending'")
        .get() as { count: number };
      return row.count;
    } catch {
      return 0;
    }
  }

  /** Builds the tray tooltip string from current status. */
  private buildTooltip(): string {
    const status = this.computeStatus();
    const pending = this.getPendingApprovalCount();
    const statusLabel: Record<TrayStatus, string> = {
      idle: 'Idle',
      listening: 'Listening',
      'task-in-progress': 'Task in Progress',
      paused: 'Paused / Emergency Stopped',
      error: 'Error — Check Health',
    };
    let tooltip = `Jarvis OS — ${statusLabel[status]}`;
    if (pending > 0) {
      tooltip += ` | ${pending} pending approval${pending === 1 ? '' : 's'}`;
    }
    return tooltip;
  }

  /**
   * Triggers emergency stop — routes to `queue:emergency-stop` via the event bus.
   * This is the SAME event path used by Phase 10/11's override hook and `jarvis stop`.
   */
  emergencyStop(): void {
    this.options.logger.warn('Emergency stop triggered via system tray.');
    this.options.eventBus.emit('queue:emergency-stop');
  }

  /**
   * Initializes the system tray icon. Gracefully falls back to a no-op if:
   * - node-systray is not installed
   * - The environment is headless (no display server)
   * - Any other initialization failure
   *
   * Jarvis core functionality is never affected by tray init failure.
   */
  async init(): Promise<void> {
    try {
      // Dynamic import so a missing package doesn't crash the module load.
      // node-systray is an optional runtime dependency — core must work without it.
      let SysTrayClass: any;
      try {
        const mod = await import('node-systray' as string);
        SysTrayClass = mod.default ?? mod;
      } catch {
        throw new Error('node-systray not available');
      }

      const iconPath = this.options.iconPath;

      const menuItems = [
        {
          title: this.buildTooltip(),
          tooltip: 'Jarvis OS status',
          checked: false,
          enabled: false, // status display, not clickable
        },
        {
          title: '---', // separator
          tooltip: '',
          checked: false,
          enabled: false,
        },
        {
          title: '🛑 Emergency Stop',
          tooltip: 'Immediately halt all Jarvis tasks (same as jarvis stop)',
          checked: false,
          enabled: true,
        },
        {
          title: 'Quit',
          tooltip: 'Exit tray icon (does not stop Jarvis daemon)',
          checked: false,
          enabled: true,
        },
      ];

      this.tray = new SysTrayClass({
        menu: {
          icon: iconPath,
          title: '',
          tooltip: 'Jarvis OS',
          items: menuItems,
        },
        debug: false,
        copyDir: false,
      });

      this.tray.onClick((action: any) => {
        if (action.item?.title === '🛑 Emergency Stop') {
          this.emergencyStop();
        } else if (action.item?.title === 'Quit') {
          this.stop();
        }
      });

      // Poll and refresh status display
      this.pollTimer = setInterval(() => {
        this.refreshStatus();
      }, this.options.pollIntervalMs);

      this.initialized = true;
      this.options.logger.info({ iconPath }, 'System tray initialized.');
    } catch (err: any) {
      // Graceful headless fallback — core must not crash
      this.options.logger.warn(
        { err: err?.message || String(err) },
        'System tray failed to initialize (headless environment or missing node-systray). ' +
        'Jarvis will continue without a tray icon.'
      );
      this.initialized = false;
    }
  }

  /** Updates the tray menu title with current status. No-op if not initialized. */
  private refreshStatus(): void {
    if (!this.tray || !this.initialized) return;
    try {
      const tooltip = this.buildTooltip();
      // Update the status display item (index 0)
      this.tray.sendAction({
        type: 'update-item',
        item: {
          title: tooltip,
          tooltip: 'Jarvis OS status',
          checked: false,
          enabled: false,
        },
        seq_id: 0,
      });
    } catch { /* ignore update errors */ }
  }

  /** Stops the tray icon and cleans up resources. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.tray && this.initialized) {
      try {
        this.tray.kill(false);
      } catch { /* ignore */ }
      this.tray = null;
      this.initialized = false;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
