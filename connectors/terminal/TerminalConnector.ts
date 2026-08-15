import { spawn } from 'child_process';
import path from 'node:path';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { Logger } from 'pino';
import { redactSecrets } from '../../core/src/lib/redact.js';
import { AgentRole } from '../../core/src/permissions/policy.js';

export interface TerminalConnectorOptions {
  projectRoot: string;
  gatekeeper: PermissionGatekeeper;
  auditLog: AuditLog;
  logger: Logger;
  timeoutMs?: number;
}

export class TerminalConnector {
  private projectRoot: string;
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private logger: Logger;
  private timeoutMs: number;
  private activeProcesses = new Map<any, boolean>();

  constructor(options: TerminalConnectorOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  private validateCwd(targetDir?: string): string {
    const resolved = targetDir ? path.resolve(this.projectRoot, targetDir) : this.projectRoot;
    const relative = path.relative(this.projectRoot, resolved);
    const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
    if (isOutside) {
      throw new Error(`Path traversal violation rejected: working directory "${resolved}" escapes project root "${this.projectRoot}".`);
    }
    return resolved;
  }

  parseCommand(cmdString: string): { command: string; args: string[] } {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < cmdString.length; i++) {
      const char = cmdString[i];
      if ((char === '"' || char === "'") && (i === 0 || cmdString[i - 1] !== '\\')) {
        if (inQuotes && char === quoteChar) {
          inQuotes = false;
        } else if (!inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else {
          current += char;
        }
      } else if (char === ' ' && !inQuotes) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) {
      args.push(current);
    }

    if (args.length === 0) {
      throw new Error('Empty command');
    }

    return {
      command: args[0],
      args: args.slice(1),
    };
  }

  async execute(actor: AgentRole, commandString: string, cwdDir?: string, actingOnBehalfOf?: AgentRole): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
    const targetCwd = this.validateCwd(cwdDir);

    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'terminal-run',
      params: { command: commandString, cwd: targetCwd, actingOnBehalfOf },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'terminal-run', 'denied — not-permitted');
      throw new Error(`Command execution denied: permission not granted.`);
    }

    // Command Injection Check (Additional security layer)
    const shellMetacharacters = /[;&|><\$\(\)`]/;
    if (shellMetacharacters.test(commandString)) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'terminal-run', 'denied — potential command injection detected');
      throw new Error('Command execution rejected: shell metacharacters detected.');
    }

    const { command, args } = this.parseCommand(commandString);

    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const actualCmd = isWin && (command === 'npm' || command === 'npx' || command === 'git') ? `${command}.cmd` : command;

      const child = spawn(actualCmd, args, {
        cwd: targetCwd,
        shell: false,
      });

      this.activeProcesses.set(child, false);

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (isWin) {
            spawn('taskkill', ['/pid', child.pid!.toString(), '/f', '/t']);
          } else {
            child.kill('SIGKILL');
          }
        } catch (e) {
          // ignore
        }
      }, this.timeoutMs);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err: any) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        const errMsg = redactSecrets(err.message || String(err)) as string;
        this.auditLog.recordOutcome(authorization.correlationId, actor, 'terminal-run', `error — ${errMsg}`);
        resolve({
          stdout: redactSecrets(stdout) as string,
          stderr: redactSecrets(stderr) as string,
          exitCode: null,
          error: `Process error: ${errMsg}`,
        });
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        const wasKilled = this.activeProcesses.get(child);
        this.activeProcesses.delete(child);

        const redactedStdout = redactSecrets(stdout) as string;
        const redactedStderr = redactSecrets(stderr) as string;

        if (timedOut || wasKilled) {
          const reason = timedOut ? 'process timed out' : 'process terminated';
          this.auditLog.recordOutcome(authorization.correlationId, actor, 'terminal-run', `error — ${reason} and killed`);
          resolve({
            stdout: redactedStdout,
            stderr: redactedStderr,
            exitCode: null,
            error: timedOut ? 'Process timed out' : 'Process terminated',
          });
        } else {
          this.auditLog.recordOutcome(authorization.correlationId, actor, 'terminal-run', `success — exit code ${code}`);
          resolve({
            stdout: redactedStdout,
            stderr: redactedStderr,
            exitCode: code,
          });
        }
      });
    });
  }

  async killAll(): Promise<void> {
    for (const child of this.activeProcesses.keys()) {
      try {
        this.activeProcesses.set(child, true);
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', child.pid.toString(), '/f', '/t']);
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
    }
  }
}
