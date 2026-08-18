import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult, AgentMessage, deriveProjectTag } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { MemoryManager } from '../../core/src/memory/memoryManager.js';
import { MessageRouter } from '../../core/src/router/messageRouter.js';
import crypto from 'node:crypto';

export class SoftwareEngineerAgent implements Agent {
  readonly name = 'software-engineer';
  private modelRouter: ModelRouter;
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private memoryManager: MemoryManager;
  private logger: Logger;
  private messageRouter?: MessageRouter;

  constructor(
    modelRouter: ModelRouter,
    gatekeeper: PermissionGatekeeper,
    auditLog: AuditLog,
    memoryManager: MemoryManager,
    logger: Logger,
    messageRouter?: MessageRouter
  ) {
    this.modelRouter = modelRouter;
    this.gatekeeper = gatekeeper;
    this.auditLog = auditLog;
    this.memoryManager = memoryManager;
    this.logger = logger;
    this.messageRouter = messageRouter;
  }

  /**
   * Process a coding task. Routes requirements to the model, and optionally writes
   * files to disk gated by the PermissionGatekeeper.
   *
   * @param input Coding requirement description and optional execution context.
   * @returns Resolves to an AgentResult describing the status, files mutated, and description.
   */
  async process(input: AgentTaskInput): Promise<AgentResult> {
    const tag = deriveProjectTag(input);

    // 1. Recall prior context/memories using the project tag
    let recalledContext = '';
    try {
      const memories = await this.memoryManager.query(input.description, { tag, limit: 5 }, this.name);
      if (memories && memories.length > 0) {
        recalledContext = '\n\n[RECALLED PRIOR CONTEXT/MEMORIES]:\n' +
          memories.map((m, idx) => `Memory ${idx + 1} (${m.sourceAgent} @ ${m.timestamp}): ${m.content}`).join('\n');
      }
    } catch (error: any) {
      this.logger.warn(
        { err: error?.message || String(error), tag },
        'MemoryManager failed to recall context. Proceeding normally.'
      );
    }

    const enrichedDescription = recalledContext
      ? `${input.description}\n\n${recalledContext}`
      : input.description;

    // 2. Route task to the model router (Exceptions bypass catch and propagate out)
    const modelResponse = await this.modelRouter.route('coding', {
      description: enrichedDescription,
      fileContext: input.fileContext,
    });

    // 3. Extract target path from fileContext if present
    const fileContext = input.fileContext as Record<string, any> | undefined;
    const targetPath = (fileContext && typeof fileContext === 'object' && typeof fileContext.targetPath === 'string')
      ? fileContext.targetPath
      : undefined;

    // If no targetPath is specified, resolve task immediately without disk operations
    if (!targetPath) {
      const successResult: AgentResult = {
        status: 'completed',
        filesChanged: [],
        explanation: modelResponse.text,
      };

      // Store task completion memory
      const memoryContent = `Successfully completed task: ${input.description}. Result: ${modelResponse.text}`;
      try {
        await this.memoryManager.store({
          content: memoryContent,
          sourceAgent: this.name,
          sourceTaskId: input.taskId,
          tag,
        });
      } catch (err: any) {
        this.logger.warn(
          { err: err?.message || String(err), taskId: input.taskId },
          'MemoryManager failed to store completion memory. Task outcome unaffected.'
        );
      }

      return successResult;
    }

    // 4. Resolve path and gate disk writes via the PermissionGatekeeper
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
      if (authorization.denialReason === 'pending-approval') {
        return {
          status: 'pending-approval',
          filesChanged: [],
          explanation: `Write to path "${resolvedPath}" paused for Unattended Approval.`,
        };
      }

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

    // 5. Create directory structure and perform disk write
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

      // Perform code review if messageRouter is registered
      if (this.messageRouter) {
        const reviewMsg = {
          id: crypto.randomUUID(),
          sender: this.name,
          recipient: 'code-reviewer',
          type: 'review-request',
          payload: {
            taskId: input.taskId,
            description: input.description,
            filesChanged: [resolvedPath],
          },
          timestamp: new Date().toISOString(),
        };

        try {
          const reply = await this.messageRouter.sendAndReceive(reviewMsg as any);
          if (reply.payload.verdict === 'request-changes') {
            return {
              status: 'failed',
              filesChanged: [resolvedPath],
              explanation: `Review rejected: ${reply.payload.explanation || 'Changes requested.'}`,
            };
          }
        } catch (err: any) {
          this.logger.error({ err }, 'Code review timed out or failed.');
        }
      }

      const successResult: AgentResult = {
        status: 'completed',
        filesChanged: [resolvedPath],
        explanation: `Successfully wrote file to ${resolvedPath}`,
      };

      // Store task completion memory
      const memoryContent = `Successfully completed task: ${input.description}. Wrote ${modelResponse.text.length} bytes to ${resolvedPath}`;
      try {
        await this.memoryManager.store({
          content: memoryContent,
          sourceAgent: this.name,
          sourceTaskId: input.taskId,
          tag,
        });
      } catch (err: any) {
        this.logger.warn(
          { err: err?.message || String(err), taskId: input.taskId },
          'MemoryManager failed to store completion memory. Task outcome unaffected.'
        );
      }

      return successResult;
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

  /**
   * Listens for incoming messages (e.g. delegated write-file requests).
   */
  async receiveMessage(message: AgentMessage): Promise<AgentMessage | null> {
    if (message.type === 'write-file-request') {
      const { path: filePath, content } = message.payload;
      const resolvedPath = path.resolve(filePath);

      const authorization = await this.gatekeeper.authorize({
        actor: this.name,
        action: 'file-write',
        params: {
          path: resolvedPath,
          taskId: 'delegated-task',
          bytes: content.length,
          actingOnBehalfOf: message.sender as any,
        },
      });

      if (!authorization.granted) {
        if (authorization.denialReason === 'pending-approval') {
          return {
            id: crypto.randomUUID(),
            sender: this.name,
            recipient: message.sender,
            type: 'write-file-response',
            payload: { success: false, error: 'pending-approval' },
            correlationId: message.id,
            timestamp: new Date().toISOString(),
          };
        }

        return {
          id: crypto.randomUUID(),
          sender: this.name,
          recipient: message.sender,
          type: 'write-file-response',
          payload: { success: false, error: 'permission-denied' },
          correlationId: message.id,
          timestamp: new Date().toISOString(),
        };
      }

      try {
        fs.writeFileSync(resolvedPath, content, 'utf8');
        this.auditLog.recordOutcome(
          authorization.correlationId,
          this.name,
          'file-write',
          `success — wrote ${content.length} bytes to ${resolvedPath} (delegated on behalf of ${message.sender})`
        );
        return {
          id: crypto.randomUUID(),
          sender: this.name,
          recipient: message.sender,
          type: 'write-file-response',
          payload: { success: true },
          correlationId: message.id,
          timestamp: new Date().toISOString(),
        };
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        this.auditLog.recordOutcome(
          authorization.correlationId,
          this.name,
          'file-write',
          `error — ${errMsg}`
        );
        return {
          id: crypto.randomUUID(),
          sender: this.name,
          recipient: message.sender,
          type: 'write-file-response',
          payload: { success: false, error: errMsg },
          correlationId: message.id,
          timestamp: new Date().toISOString(),
        };
      }
    }
    return null;
  }
}

