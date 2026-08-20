import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { AgentRole } from '../../core/src/permissions/policy.js';
import { loadConfig } from '../../core/src/lib/config.js';
import { ComputerVisionConnector } from '../vision/ComputerVisionConnector.js';

export interface DesktopConnectorOptions {
  gatekeeper: PermissionGatekeeper;
  auditLog: AuditLog;
  visionConnector: ComputerVisionConnector;
  logger: any;
}

export interface DesktopActionResult {
  status: 'SUCCESS' | 'FAILED' | 'DENIED' | 'CONFIRMATION_REQUIRED' | 'UNCERTAIN';
  message: string;
  screenshotPathBefore?: string;
  screenshotPathAfter?: string;
  error?: string;
}

export class DesktopConnector {
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private visionConnector: ComputerVisionConnector;
  private logger: any;
  private actionCount = 0;
  private emergencyStopped = false;

  constructor(options: DesktopConnectorOptions) {
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.visionConnector = options.visionConnector;
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
    params: { x?: number; y?: number; text?: string; key?: string; display?: number }
  ): Promise<{ granted: boolean; error?: string; correlationId: string }> {
    const config = loadConfig(false);

    // 0. Emergency Stop check
    if (this.emergencyStopped) {
      return { granted: false, error: 'Rejection: Action blocked due to active emergency-stop condition.', correlationId: 'n-a' };
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
    if (action === 'desktop-mouse' && params.x !== undefined && params.y !== undefined) {
      const x = params.x;
      const y = params.y;

      if (x < 0 || y < 0) {
        return { granted: false, error: `Invalid coordinates: Negative dimensions are rejected (X: ${x}, Y: ${y}).`, correlationId: 'n-a' };
      }

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
      if (x >= lastObs.width || y >= lastObs.height) {
        return { granted: false, error: `Coordinate safety rejection: Coordinates (${x}, ${y}) are out of display bounds (${lastObs.width}x${lastObs.height}).`, correlationId: 'n-a' };
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

  private async executeScript(args: string[]): Promise<void> {
    const config = loadConfig(false);
    const scriptPath = path.resolve(config.projectRoot, 'scripts/desktop_input.ps1');

    await new Promise<void>((resolve, reject) => {
      const ps = spawn('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        ...args
      ]);

      const timeout = setTimeout(() => {
        ps.kill('SIGKILL');
        reject(new Error('Desktop interaction command timed out.'));
      }, config.desktopActionTimeoutMs);

      let stderr = '';
      ps.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      ps.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Desktop script failed with code ${code}. Stderr: ${stderr}`));
        }
      });

      ps.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async moveMouse(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { x, y, display }, ['move', x.toString(), y.toString()]);
  }

  async click(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { x, y, display }, ['click', x.toString(), y.toString()]);
  }

  async doubleClick(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { x, y, display }, ['doubleclick', x.toString(), y.toString()]);
  }

  async rightClick(actor: AgentRole, x: number, y: number, display?: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { x, y, display }, ['rightclick', x.toString(), y.toString()]);
  }

  async scroll(actor: AgentRole, amount: number): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-mouse', { amount }, ['scroll', amount.toString()]);
  }

  async typeText(actor: AgentRole, text: string): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-keyboard', { text }, ['type', text]);
  }

  async pressKey(actor: AgentRole, key: string): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-keyboard', { key }, ['press', key]);
  }

  async hotkey(actor: AgentRole, keys: string): Promise<DesktopActionResult> {
    return this.runAction(actor, 'desktop-keyboard', { keys }, ['hotkey', keys]);
  }

  private async runAction(
    actor: AgentRole,
    action: 'desktop-mouse' | 'desktop-keyboard',
    params: any,
    args: string[]
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
      await this.executeScript(args);

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
        `success — executed desktop command [${args[0]}]`
      );

      return {
        status: 'SUCCESS',
        message: `Successfully executed desktop action: ${args.join(' ')}`,
        screenshotPathBefore,
        screenshotPathAfter,
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
