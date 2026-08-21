import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../../core/src/lib/config.js';
import { JarvisEventBus } from '../../core/src/events/bus.js';

export interface OverrideHookConnectorOptions {
  eventBus: JarvisEventBus;
  logger: any;
}

export class OverrideHookConnector extends EventEmitter {
  private eventBus: JarvisEventBus;
  private logger: any;
  private process: ChildProcess | null = null;
  private status: 'inactive' | 'installing' | 'active' | 'failed' = 'inactive';
  private lastError: string | null = null;

  constructor(options: OverrideHookConnectorOptions) {
    super();
    this.eventBus = options.eventBus;
    this.logger = options.logger;
  }

  getStatus() {
    return this.status;
  }

  getLastError() {
    return this.lastError;
  }

  async start(): Promise<void> {
    const config = loadConfig(false);
    if (!config.desktopControlEnabled) {
      this.status = 'inactive';
      this.logger.info('OverrideHookConnector: Desktop control is disabled. Override hook not installed.');
      return;
    }

    if (process.platform !== 'win32') {
      this.logger.warn('OverrideHookConnector: Low-level hooks are only supported on Windows. Running in mock/bypass mode for non-Windows environment.');
      this.status = 'active';
      return;
    }

    this.status = 'installing';
    this.logger.info('Installing low-level Windows keyboard and mouse override hook...');

    const scriptPath = path.resolve(config.projectRoot, 'scripts/input_hook.ps1');
    const threshold = process.env.JARVIS_OVERRIDE_MOUSE_THRESHOLD || '10';

    return new Promise<void>((resolve, reject) => {
      this.process = spawn('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        threshold
      ]);

      let isResolved = false;

      this.process.stdout?.on('data', (data) => {
        const chunk = data.toString().trim();
        this.logger.debug(`Hook process output: ${chunk}`);

        if (chunk.includes('HOOK_ACTIVE')) {
          this.status = 'active';
          isResolved = true;
          this.logger.info('Global Windows keyboard/mouse override hook active.');
          resolve();
        }

        if (chunk.includes('OVERRIDE:')) {
          this.logger.warn(`GENUINE hardware input override detected! [${chunk}]`);
          this.eventBus.emit('queue:emergency-stop');
        }
      });

      this.process.stderr?.on('data', (data) => {
        const errStr = data.toString().trim();
        this.logger.error(`Hook process error: ${errStr}`);
        this.lastError = errStr;
      });

      this.process.on('close', (code) => {
        this.logger.warn(`Hook process closed with code ${code}`);
        if (!isResolved) {
          this.status = 'failed';
          this.lastError = this.lastError || `Process exited with code ${code}`;
          reject(new Error(`Failed to install global override hook: ${this.lastError}`));
        } else {
          this.status = 'inactive';
        }
      });

      this.process.on('error', (err) => {
        this.logger.error({ err }, 'Hook process error event');
        this.lastError = err.message;
        if (!isResolved) {
          this.status = 'failed';
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
    this.status = 'inactive';
    this.logger.info('OverrideHookConnector stopped.');
  }

  async startInTestMode(): Promise<void> {
    const config = loadConfig(false);
    this.status = 'installing';
    const scriptPath = path.resolve(config.projectRoot, 'scripts/input_hook.ps1');

    return new Promise<void>((resolve, reject) => {
      this.process = spawn('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        'TEST_MODE'
      ]);

      let isResolved = false;

      this.process.stdout?.on('data', (data) => {
        const lines = data.toString().split(/\r?\n/);
        for (let line of lines) {
          line = line.trim();
          if (!line) continue;

          this.logger.debug(`Hook test process output line: ${line}`);

          if (line.includes('HOOK_ACTIVE')) {
            this.status = 'active';
            isResolved = true;
            resolve();
          }

          if (line.includes('OVERRIDE:')) {
            this.logger.warn(`GENUINE hardware input override detected in test! [${line}]`);
            this.emit('override', line);
            this.eventBus.emit('queue:emergency-stop');
          }
        }
      });

      this.process.stderr?.on('data', (data) => {
        const errStr = data.toString().trim();
        this.logger.error(`Hook test process error: ${errStr}`);
      });

      this.process.on('close', (code) => {
        if (!isResolved) {
          this.status = 'failed';
          reject(new Error(`Failed in test mode: code ${code}`));
        } else {
          this.status = 'inactive';
        }
      });
    });
  }

  sendTestKey(vkCode: number, flags: number) {
    if (this.process && this.process.stdin) {
      this.process.stdin.write(`TEST_KEY:${vkCode},${flags}\r\n`);
    }
  }

  sendTestMouse(x: number, y: number, flags: number, isMove: boolean) {
    if (this.process && this.process.stdin) {
      this.process.stdin.write(`TEST_MOUSE:${x},${y},${flags},${isMove}\r\n`);
    }
  }

  // Support simulated events for tests
  simulateOverrideEvent(type: string) {
    this.logger.info(`Simulated override event: ${type}`);
    this.eventBus.emit('queue:emergency-stop');
  }
}
