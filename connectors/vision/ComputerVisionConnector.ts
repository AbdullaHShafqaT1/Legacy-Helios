import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { AgentRole } from '../../core/src/permissions/policy.js';
import { loadConfig } from '../../core/src/lib/config.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { redactSecrets } from '../../core/src/lib/redact.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DesktopObservation {
  success: boolean;
  timestamp: string;
  display: number;
  width: number;
  height: number;
  buffer?: Buffer;
  base64?: string;
  screenshotPath?: string;
  imageFixtureFallbackUsed: boolean;
  error?: string;
}

export interface ComputerVisionConnectorOptions {
  gatekeeper: PermissionGatekeeper;
  auditLog: AuditLog;
  modelRouter: ModelRouter;
  logger: any;
}

export class ComputerVisionConnector {
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private modelRouter: ModelRouter;
  private logger: any;
  public lastObservation: DesktopObservation | null = null;

  constructor(options: ComputerVisionConnectorOptions) {
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.modelRouter = options.modelRouter;
    this.logger = options.logger;
  }

  /**
   * Captures a screenshot of the specified monitor display and returns a structured DesktopObservation.
   * Direct in-memory screengrab logic without PowerShell-to-Python trampolines.
   */
  async captureScreen(actor: AgentRole, displayIndex?: number): Promise<DesktopObservation> {
    const config = loadConfig(false);
    const preferredDisplay = displayIndex ?? config.visionPreferredDisplay;

    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'vision-read',
      params: { display: preferredDisplay },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'vision-read', 'denied — not-permitted');
      throw new Error(`Vision capture denied: permission not granted.`);
    }

    const timestamp = new Date().toISOString();

    if (preferredDisplay < 0 || preferredDisplay >= 10) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'vision-read', `failed — invalid display index ${preferredDisplay}`);
      return {
        success: false,
        timestamp,
        display: preferredDisplay,
        width: 0,
        height: 0,
        imageFixtureFallbackUsed: false,
        error: `Invalid display index: ${preferredDisplay}`,
      };
    }

    const tempDir = os.tmpdir();
    const targetFilename = `screenshot_${Date.now()}.png`;
    const targetPath = path.join(tempDir, targetFilename);
    const scriptPath = path.resolve(config.projectRoot, 'tools/desktop_control.py');

    try {
      const ps = spawn('python', [
        scriptPath,
        JSON.stringify({ action: 'screenshot', screenshot_path: targetPath })
      ]);

      let stdout = '';
      let stderr = '';

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ps.kill('SIGKILL');
          reject(new Error('Screenshot capture timed out.'));
        }, config.visionCaptureTimeoutMs);

        ps.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        ps.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        ps.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Screenshot script failed with exit code ${code}. Stderr: ${stderr}`));
          }
        });

        ps.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const parsed = JSON.parse(stdout.trim());
      const width = parsed.width || 1920;
      const height = parsed.height || 1080;
      const base64Data = parsed.base64;
      const buffer = base64Data ? Buffer.from(base64Data, 'base64') : undefined;

      const observation: DesktopObservation = {
        success: true,
        timestamp,
        display: preferredDisplay,
        width,
        height,
        buffer,
        base64: base64Data,
        screenshotPath: targetPath,
        imageFixtureFallbackUsed: false,
      };

      this.lastObservation = observation;

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'vision-read',
        `success — screen capture completed (${width}x${height})`
      );

      return observation;
    } catch (err: any) {
      this.logger.warn({ err: err.message }, 'Real screenshot capture failed. Evaluating fallback.');

      // Check if fallback is enabled or if fixture exists
      const fixturePath = path.resolve(config.projectRoot, 'core/test/fixtures/desktop_screenshot.png');
      const isDefaultDisplay = preferredDisplay === 0;
      if (isDefaultDisplay && (config.voiceCiFallback || process.env.NODE_ENV === 'test') && fs.existsSync(fixturePath)) {
        // Fallback to pre-rendered image file
        const observation: DesktopObservation = {
          success: true,
          timestamp,
          display: preferredDisplay,
          width: 1280,
          height: 720,
          screenshotPath: fixturePath,
          imageFixtureFallbackUsed: true,
        };

        this.lastObservation = observation;

        this.auditLog.recordOutcome(
          authorization.correlationId,
          actor,
          'vision-read',
          `success — fallback screen fixture read from ${fixturePath}`
        );

        return observation;
      }

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'vision-read',
        `failed — ${err.message}`
      );

      return {
        success: false,
        timestamp,
        display: preferredDisplay,
        width: 0,
        height: 0,
        imageFixtureFallbackUsed: false,
        error: err.message,
      };
    }
  }

  /**
   * Captures screen and passes image block base64 payload to multimodal router model for understanding/OCR.
   */
  async analyzeScreen(actor: AgentRole, prompt: string, displayIndex?: number): Promise<string> {
    const observation = await this.captureScreen(actor, displayIndex);

    if (!observation.success) {
      throw new Error(`Screen analysis failed: Unable to acquire screenshot. Reason: ${observation.error}`);
    }

    const base64Data = observation.base64 || (observation.screenshotPath ? fs.readFileSync(observation.screenshotPath).toString('base64') : '');
    
    // Route request to multimodal ModelRouter
    const modelResponse = await this.modelRouter.route('vision', {
      description: prompt,
      image: {
        base64: base64Data,
        mediaType: 'image/png',
      },
    });

    return modelResponse.text;
  }
}
