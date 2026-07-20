import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';

export class SoftwareEngineerAgent implements Agent {
  readonly name = 'software-engineer';
  private modelRouter: ModelRouter;
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private logger: Logger;

  constructor(
    modelRouter: ModelRouter,
    gatekeeper: PermissionGatekeeper,
    auditLog: AuditLog,
    logger: Logger
  ) {
    this.modelRouter = modelRouter;
    this.gatekeeper = gatekeeper;
    this.auditLog = auditLog;
    this.logger = logger;
  }

  /**
   * Process a coding task. Routes requirements to the model, and optionally writes
   * files to disk gated by the PermissionGatekeeper.
   *
   * @param input Coding requirement description and optional execution context.
   * @returns Resolves to an AgentResult describing the status, files mutated, and description.
   */
  async process(input: AgentTaskInput): Promise<AgentResult> {
    // 1. Route task to the model router (Exceptions bypass catch and propagate out)
    const modelResponse = await this.modelRouter.route('coding', {
      description: input.description,
      fileContext: input.fileContext,
    });

    // 2. Extract target path from fileContext if present
    const fileContext = input.fileContext as Record<string, any> | undefined;
    const targetPath = (fileContext && typeof fileContext === 'object' && typeof fileContext.targetPath === 'string')
      ? fileContext.targetPath
      : undefined;

    // If no targetPath is specified, resolve task immediately without disk operations
    if (!targetPath) {
      return {
        status: 'completed',
        filesChanged: [],
        explanation: modelResponse.text,
      };
    }

    // 3. Resolve path and gate disk writes via the PermissionGatekeeper
    const resolvedPath = path.resolve(targetPath);

    const authorization = await this.gatekeeper.authorize({
      actor: this.name,
      action: 'file-write',
      params: {
        path: resolvedPath,
        taskId: input.taskId,
        bytes: modelResponse.text.length,
      },
    });

    if (!authorization.granted) {
      const outcomeText = authorization.denialReason === 'timeout'
        ? 'denied — timeout'
        : authorization.denialReason === 'not-permitted'
        ? 'denied — not-permitted'
        : 'denied — no write performed';
      // Record failed outcome in the audit log
      this.auditLog.recordOutcome(
        authorization.correlationId,
        this.name,
        'file-write',
        outcomeText
      );

      return {
        status: 'failed',
        filesChanged: [],
        explanation: `Write to path "${resolvedPath}" was denied by the gatekeeper.`,
        error: 'permission-denied',
      };
    }

    // 4. Create directory structure and perform disk write
    try {
      const parentDir = path.dirname(resolvedPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.writeFileSync(resolvedPath, modelResponse.text, 'utf8');

      // Record successful write in audit log
      this.auditLog.recordOutcome(
        authorization.correlationId,
        this.name,
        'file-write',
        `success — wrote ${modelResponse.text.length} bytes to ${resolvedPath}`
      );

      return {
        status: 'completed',
        filesChanged: [resolvedPath],
        explanation: `Successfully wrote file to ${resolvedPath}`,
      };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);

      // Record write exception details in audit log
      this.auditLog.recordOutcome(
        authorization.correlationId,
        this.name,
        'file-write',
        `error — ${errorMsg}`
      );

      return {
        status: 'failed',
        filesChanged: [],
        explanation: `Failed to write file to ${resolvedPath}: ${errorMsg}`,
        error: errorMsg,
      };
    }
  }
}
