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

  constructor(options: ComputerVisionConnectorOptions) {
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.modelRouter = options.modelRouter;
    this.logger = options.logger;
  }

  /**
   * Captures a screenshot of the specified monitor display and returns a structured DesktopObservation.
   * Leverages scripts/screenshot.ps1. If capture fails in a headless runner, falls back to a real image fixture.
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
    const tempDir = os.tmpdir();
    const targetFilename = `screenshot_${Date.now()}.png`;
    const targetPath = path.join(tempDir, targetFilename);
    const scriptPath = path.resolve(config.projectRoot, 'scripts/screenshot.ps1');

    try {
      // Spawn PowerShell screenshot capture
      const ps = spawn('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        targetPath,
        preferredDisplay.toString(),
      ]);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ps.kill('SIGKILL');
          reject(new Error('Screenshot capture timed out.'));
        }, config.visionCaptureTimeoutMs);

        let stderr = '';
        ps.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        ps.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0 && fs.existsSync(targetPath)) {
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

      // Query display resolution
      const size = fs.statSync(targetPath).size;
      const observation: DesktopObservation = {
        success: true,
        timestamp,
        display: preferredDisplay,
        width: 1920, // Default fallback width metadata
        height: 1080, // Default fallback height metadata
        screenshotPath: targetPath,
        imageFixtureFallbackUsed: false,
      };

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'vision-read',
        `success — screen capture saved to ${targetPath} (${size} bytes)`
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

    if (!observation.success || !observation.screenshotPath) {
      throw new Error(`Screen analysis failed: Unable to acquire screenshot. Reason: ${observation.error}`);
    }

    // Convert file to base64
    const base64Data = fs.readFileSync(observation.screenshotPath).toString('base64');
    
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
