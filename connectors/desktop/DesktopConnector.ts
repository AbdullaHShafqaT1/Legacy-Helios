import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { AgentRole } from '../../core/src/permissions/policy.js';
import { loadConfig } from '../../core/src/lib/config.js';
import { ComputerVisionConnector } from '../vision/ComputerVisionConnector.js';

import { OverrideHookConnector } from '../override/OverrideHookConnector.js';

export interface DesktopConnectorOptions {
  gatekeeper: PermissionGatekeeper;
  auditLog: AuditLog;
  visionConnector: ComputerVisionConnector;
  overrideHookConnector?: OverrideHookConnector;
  logger: any;
}

export interface DesktopActionResult {
  status: 'SUCCESS' | 'FAILED' | 'DENIED' | 'CONFIRMATION_REQUIRED' | 'UNCERTAIN';
  message: string;
  screenshotPathBefore?: string;
  screenshotPathAfter?: string;
  error?: string;
  executedAt?: [number, number];
  timestamp?: string;
  displayInfo?: {
    width?: number;
    height?: number;
    dpi?: number;
    scalePercent?: number;
    [key: string]: any;
  };
  details?: Record<string, any>;
}

export class DesktopConnector {
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private visionConnector: ComputerVisionConnector;
  private overrideHookConnector?: OverrideHookConnector;
  private logger: any;
  private actionCount = 0;
  private emergencyStopped = false;

  constructor(options: DesktopConnectorOptions) {
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.visionConnector = options.visionConnector;
    this.overrideHookConnector = options.overrideHookConnector;
    this.logger = options.logger;
  }

  resetActionCount() {
    this.actionCount = 0;
    this.emergencyStopped = false;
  }

  emergencyStop() {
    this.emergencyStopped = true;
  }

  private async validateSafety(
    actor: AgentRole,
    action: 'desktop-mouse' | 'desktop-keyboard',
    params: {
      x?: number;
      y?: number;
      start_x?: number;
      start_y?: number;
      end_x?: number;
      end_y?: number;
      x1?: number;
      y1?: number;
      x2?: number;
      y2?: number;
      text?: string;
      key?: string;
      display?: number;
      [key: string]: any;
    }
  ): Promise<{ granted: boolean; error?: string; correlationId: string }> {
    const config = loadConfig(false);

    // 0. Emergency Stop check
    if (this.emergencyStopped) {
      return { granted: false, error: 'Rejection: Action blocked due to active emergency-stop condition.', correlationId: 'n-a' };
    }

    // 0b. Fail closed check
    if (process.platform === 'win32' && config.desktopControlEnabled) {
      if (!this.overrideHookConnector || this.overrideHookConnector.getStatus() !== 'active') {
        return {
          granted: false,
          error: 'Rejection: Global input override safety hook is not active or failed to load. Desktop control is locked to fail-closed.',
          correlationId: 'n-a'
        };
      }
    }

    // 1. Enable check
    if (!config.desktopControlEnabled) {
      return { granted: false, error: 'Desktop control is disabled in configuration.', correlationId: 'n-a' };
    }

    // 2. Action count limit check (runaway loop prevention)
    if (this.actionCount >= config.desktopMaxActionsPerSequence) {
      return { granted: false, error: `Runaway loop safety: Exceeded maximum allowed desktop actions (${config.desktopMaxActionsPerSequence}) per session sequence.`, correlationId: 'n-a' };
    }

    // 3. Coordinate bounds checks
    if (action === 'desktop-mouse') {
      const coordsToCheck: Array<{ x: number; y: number; label: string }> = [];
      if (params.x !== undefined && params.y !== undefined) {
        coordsToCheck.push({ x: params.x, y: params.y, label: `(${params.x}, ${params.y})` });
      }
      const sx = params.start_x ?? params.x1;
      const sy = params.start_y ?? params.y1;
      if (sx !== undefined && sy !== undefined && (sx !== params.x || sy !== params.y)) {
        coordsToCheck.push({ x: sx, y: sy, label: `(${sx}, ${sy})` });
      }
      const ex = params.end_x ?? params.x2;
      const ey = params.end_y ?? params.y2;
      if (ex !== undefined && ey !== undefined) {
        coordsToCheck.push({ x: ex, y: ey, label: `(${ex}, ${ey})` });
      }

      for (const pt of coordsToCheck) {
        if (pt.x < 0 || pt.y < 0) {
          return { granted: false, error: `Invalid coordinates: Negative dimensions are rejected (X: ${pt.x}, Y: ${pt.y}).`, correlationId: 'n-a' };
        }
      }

      if (coordsToCheck.length > 0) {
        // Freshness check: latest observation timestamp must be recent
        const lastObs = this.visionConnector.lastObservation;
        if (!lastObs || !lastObs.timestamp) {
          return { granted: false, error: 'Rejection: No desktop screenshot has been captured yet. Cannot target coordinates without observation context.', correlationId: 'n-a' };
        }

        const elapsed = Date.now() - new Date(lastObs.timestamp).getTime();
        if (elapsed > config.desktopObservationMaxAgeMs) {
          return { granted: false, error: `Coordinate safety rejection: Screen observation is stale (${(elapsed / 1000).toFixed(1)}s old, limit is ${config.desktopObservationMaxAgeMs / 1000}s). Capture a fresh screenshot.`, correlationId: 'n-a' };
        }

        // Check bounds against display resolution
        for (const pt of coordsToCheck) {
          if (pt.x >= lastObs.width || pt.y >= lastObs.height) {
            return { granted: false, error: `Coordinate safety rejection: Coordinates (${pt.x}, ${pt.y}) are out of display bounds (${lastObs.width}x${lastObs.height}).`, correlationId: 'n-a' };
          }
        }
      }
    }

    // 4. Keyboard text length checks
    if (action === 'desktop-keyboard' && params.text) {
      if (params.text.length > config.desktopMaxTextLength) {
        return { granted: false, error: `Text typing rejected: Input text length (${params.text.length}) exceeds configured maximum limit of ${config.desktopMaxTextLength} characters.`, correlationId: 'n-a' };
      }
    }

    // 5. Gatekeeper authorization request
    const auditParams = { ...params };
    if (auditParams.text) {
      auditParams.text = `[TEXT: Length ${auditParams.text.length} chars]`;
    }

    const authorization = await this.gatekeeper.authorize({
      actor,
      action,
      params: auditParams,
    });

    if (!authorization.granted) {
      const denialReason = authorization.denialReason === 'pending-approval' ? 'pending-approval' : `permission denied (${authorization.denialReason})`;
      return { granted: false, error: denialReason, correlationId: authorization.correlationId };
    }

    return { granted: true, correlationId: authorization.correlationId };
  }

  private daemonProcess: any = null;
  private daemonStarting: Promise<void> | null = null;
  private lineBuffer = '';
  private pendingQueue: Array<{
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  private async ensureDaemon(): Promise<void> {
    if (this.daemonProcess && !this.daemonProcess.killed) {
      return;
    }
    if (this.daemonStarting) {
      return this.daemonStarting;
    }

    this.daemonStarting = new Promise<void>((resolve, reject) => {
      const config = loadConfig(false);
      const scriptPath = path.resolve(config.projectRoot, 'tools/desktop_control.py');

      const proc = spawn('python', [scriptPath, '--daemon'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.daemonProcess = proc;
      this.lineBuffer = '';

      const readyTimeout = setTimeout(() => {
        cleanup();
        reject(new Error('Desktop background daemon timed out waiting for READY signal.'));
      }, 10000);

      const cleanup = () => {
        clearTimeout(readyTimeout);
        this.daemonStarting = null;
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        this.lineBuffer += chunk.toString();
        let newlineIndex: number;
        while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
          const line = this.lineBuffer.slice(0, newlineIndex).trim();
          this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

          if (!line) continue;

          try {
            const parsed = JSON.parse(line);
            if (parsed.status === 'READY') {
              cleanup();
              this.logger.info('Desktop persistent background daemon READY.');
              resolve();
              continue;
            }

            const pending = this.pendingQueue.shift();
            if (pending) {
              clearTimeout(pending.timeout);
              pending.resolve(parsed);
            }
          } catch (parseErr) {
            this.logger.warn({ parseErr, line }, 'Failed to parse JSON response line from desktop daemon');
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        this.logger.debug({ stderr: chunk.toString().trim() }, 'Desktop daemon stderr');
      });

      proc.on('close', (code: number) => {
        this.logger.warn({ code }, 'Desktop persistent daemon exited');
        cleanup();
        this.daemonProcess = null;
        while (this.pendingQueue.length > 0) {
          const pending = this.pendingQueue.shift();
          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(`Desktop daemon exited unexpectedly with code ${code}`));
          }
        }
      });

      proc.on('error', (err: Error) => {
        this.logger.error({ err }, 'Desktop persistent daemon failed to spawn');
        cleanup();
        this.daemonProcess = null;
        reject(err);
      });
    });

    return this.daemonStarting;
  }

  stop(): void {
    if (this.daemonProcess) {
      try {
        this.daemonProcess.stdin?.write(JSON.stringify({ action: 'exit' }) + '\n');
        setTimeout(() => {
          if (this.daemonProcess) {
            this.daemonProcess.kill('SIGKILL');
            this.daemonProcess = null;
          }
        }, 300);
      } catch {
        this.daemonProcess.kill('SIGKILL');
        this.daemonProcess = null;
      }
    }
  }

  private async executeScript(payload: any): Promise<{
    status?: string;
    executedAt?: [number, number];
    timestamp?: string;
    displayInfo?: any;
    details?: any;
    base64?: string;
    width?: number;
    height?: number;
  } | void> {
    const config = loadConfig(false);
    await this.ensureDaemon();

    return new Promise((resolve, reject) => {
      if (!this.daemonProcess || !this.daemonProcess.stdin) {
        return reject(new Error('Desktop background daemon is not running'));
      }

      const timeout = setTimeout(() => {
        const idx = this.pendingQueue.findIndex(p => p.timeout === timeout);
        if (idx !== -1) {
          this.pendingQueue.splice(idx, 1);
        }
        reject(new Error('Desktop interaction command timed out.'));
      }, config.desktopActionTimeoutMs);

      this.pendingQueue.push({
        resolve: (parsed: any) => {
          if (parsed.status === 'FAILED') {
            reject(new Error(parsed.error || 'Desktop action failed'));
          } else {
            resolve({
              status: parsed.status,
              executedAt: parsed.executed_at ?? parsed.cursor,
              timestamp: parsed.timestamp || new Date().toISOString(),
              displayInfo: parsed.display,
              details: parsed,
              base64: parsed.base64,
              width: parsed.width,
              height: parsed.height,
            });
          }
        },
        reject,
        timeout,
      });

      this.daemonProcess.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  // Single-purpose mouse tools
  async mouseClick(
    actor: AgentRole,
    x: number,
    y: number,
    clickType: 'single' | 'double' | 'right' = 'single'
  ): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', {
      action: 'mouse_click',
      x,
      y,
      click_type: clickType,
    });
  }

  async mouseMove(
    actor: AgentRole,
    x: number,
    y: number,
    smooth: boolean = false
  ): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', {
      action: 'mouse_move',
      x,
      y,
      smooth,
    });
  }

  async mouseDrag(
    actor: AgentRole,
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', {
      action: 'mouse_drag',
      start_x: startX,
      start_y: startY,
      end_x: endX,
      end_y: endY,
      x: startX,
      y: startY,
    });
  }

  async mouseScroll(
    actor: AgentRole,
    direction: 'up' | 'down',
    amount: number = 3
  ): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', {
      action: 'mouse_scroll',
      direction,
      amount,
    });
  }

  async getDisplayInfo(actor: AgentRole): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', {
      action: 'display_info',
    });
  }

  async moveMouse(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { action: 'move', x, y, display });
  }

  async click(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { action: 'click', x, y, display });
  }

  async doubleClick(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { action: 'doubleclick', x, y, display });
  }

  async rightClick(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { action: 'rightclick', x, y, display });
  }

  async dragMouse(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { action: 'drag', x, y, display });
  }

  async scroll(actor: AgentRole, amount: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { action: 'scroll', amount });
  }

  async typeText(actor: AgentRole, text: string): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-keyboard', { action: 'type', text });
  }

  async pressKey(actor: AgentRole, key: string): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-keyboard', { action: 'press', key });
  }

  async hotkey(actor: AgentRole, keys: string): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-keyboard', { action: 'hotkey', keys });
  }

  async focusWindow(actor: AgentRole, targetWindow?: string): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-keyboard', { action: 'focus_window', target_window: targetWindow });
  }

  async cloudcodeOversight(actor: AgentRole, url: string, workspace: string): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-keyboard', { action: 'cloudcode_oversight', url, workspace });
  }

  async captureScreen(actor: AgentRole): Promise<any> {
    return this.visionConnector.captureScreen(actor);
  }

  private async runAction(
    actor: AgentRole,
    action: 'desktop-mouse' | 'desktop-keyboard',
    params: any
  ): Promise<DesktopActionResult> {
    const safety = await this.validateSafety(actor, action, params);
    if (!safety.granted) {
      if (safety.correlationId !== 'n-a') {
        this.auditLog.recordOutcome(safety.correlationId, actor, action, `denied — ${safety.error}`);
      }
      const isPending = safety.error === 'pending-approval';
      return {
        status: isPending ? 'CONFIRMATION_REQUIRED' : 'DENIED',
        message: safety.error || 'Permission denied.'
      };
    }

    this.actionCount++;

    let screenshotPathBefore: string | undefined;
    try {
      const beforeObs = await this.visionConnector.captureScreen(actor);
      if (beforeObs.success) screenshotPathBefore = beforeObs.screenshotPath;
    } catch {
      // Swallowed
    }

    try {
      const scriptResult = (await this.executeScript(params)) as any;

      let screenshotPathAfter: string | undefined;
      try {
        const afterObs = await this.visionConnector.captureScreen(actor);
        if (afterObs.success) screenshotPathAfter = afterObs.screenshotPath;
      } catch {
        // Swallowed
      }

      this.auditLog.recordOutcome(
        safety.correlationId,
        actor,
        action,
        `success — executed desktop command [${params.action}]`
      );

      const executedPos: [number, number] | undefined =
        scriptResult?.executedAt ??
        (params.x !== undefined && params.y !== undefined ? [params.x, params.y] : undefined);

      return {
        status: 'SUCCESS',
        message: `Successfully executed desktop action: ${params.action}`,
        screenshotPathBefore,
        screenshotPathAfter,
        executedAt: executedPos,
        timestamp: scriptResult?.timestamp || new Date().toISOString(),
        displayInfo: scriptResult?.displayInfo,
        details: scriptResult?.details,
      };
    } catch (err: any) {
      this.auditLog.recordOutcome(
        safety.correlationId,
        actor,
        action,
        `failed — script execution error: ${err.message}`
      );

      return {
        status: 'FAILED',
        message: `Action execution failed: ${err.message}`,
        screenshotPathBefore,
        error: err.message,
      };
    }
  }
}
