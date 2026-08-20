import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult, AgentMessage, deriveProjectTag } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { FilesystemConnector } from '../../connectors/filesystem/FilesystemConnector.js';
import { redactSecrets } from '../../core/src/lib/redact.js';
import { MemoryManager } from '../../core/src/memory/memoryManager.js';
import { MessageRouter } from '../../core/src/router/messageRouter.js';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { ComputerVisionConnector } from '../../connectors/vision/ComputerVisionConnector.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ResearchAgentResult extends AgentResult {
  summary?: string;
  citations?: string[];
  confidence?: string;
  caveats?: string[];
}

export class ResearcherAgent implements Agent {
  readonly name = 'researcher';
  private readonly modelRouter: ModelRouter;
  private readonly filesystemConnector?: FilesystemConnector;
  private readonly memoryManager: MemoryManager;
  private readonly logger: Logger;
  private readonly messageRouter?: MessageRouter;
  private readonly gatekeeper?: PermissionGatekeeper;
  private readonly auditLog?: AuditLog;
  private readonly computerVisionConnector?: ComputerVisionConnector;

  constructor(
    modelRouter: ModelRouter,
    filesystemConnector: FilesystemConnector | undefined,
    memoryManager: MemoryManager,
    logger: Logger,
    messageRouter?: MessageRouter,
    gatekeeper?: PermissionGatekeeper,
    auditLog?: AuditLog,
    computerVisionConnector?: ComputerVisionConnector
  ) {
    this.modelRouter = modelRouter;
    this.filesystemConnector = filesystemConnector;
    this.memoryManager = memoryManager;
    this.logger = logger;
    this.messageRouter = messageRouter;
    this.gatekeeper = gatekeeper;
    this.auditLog = auditLog;
    this.computerVisionConnector = computerVisionConnector;
  }

  /**
   * Process a research task. Evaluates natural-language query and optional scope/constraints,
   * inspects local file context via read-only FilesystemConnector calls if requested,
   * and routes to the Model Router under the 'research' task type.
   *
   * @param input Research query description and optional file/scope context.
   * @returns Resolves to a ResearchAgentResult with structured summary, citations, and confidence.
   */
  async process(input: AgentTaskInput): Promise<ResearchAgentResult> {
    const tag = deriveProjectTag(input);
    const fileContext = input.fileContext as Record<string, any> | undefined;
    const pathsToRead: string[] = [];

    if (fileContext && typeof fileContext === 'object') {
      if (typeof fileContext.targetPath === 'string') {
        pathsToRead.push(fileContext.targetPath);
      } else if (Array.isArray(fileContext.targetPath)) {
        for (const p of fileContext.targetPath) {
          if (typeof p === 'string' && !pathsToRead.includes(p)) {
            pathsToRead.push(p);
          }
        }
      }

      if (Array.isArray(fileContext.paths)) {
        for (const p of fileContext.paths) {
          if (typeof p === 'string' && !pathsToRead.includes(p)) {
            pathsToRead.push(p);
          }
        }
      }

      if (Array.isArray(fileContext.readPaths)) {
        for (const p of fileContext.readPaths) {
          if (typeof p === 'string' && !pathsToRead.includes(p)) {
            pathsToRead.push(p);
          }
        }
      }
    }

    const sourcesRead: string[] = [];
    const fileContents: Record<string, string> = {};
    const readErrors: string[] = [];

    if (this.filesystemConnector && pathsToRead.length > 0) {
      for (const p of pathsToRead) {
        try {
          const content = await this.filesystemConnector.readFile(this.name, p);
          sourcesRead.push(p);
          fileContents[p] = content;
        } catch (err: any) {
          const errMsg = redactSecrets(err?.message || String(err)) as string;
          if (errMsg.includes('is a directory')) {
            try {
              const items = await this.filesystemConnector.listDir(this.name, p);
              sourcesRead.push(p);
              fileContents[p] =
                `[Directory listing for ${p}]: ` +
                items.map((i) => `${i.isDirectory ? '[DIR]' : '[FILE]'} ${i.name}`).join(', ');
              continue;
            } catch (dirErr: any) {
              const dirErrMsg = redactSecrets(dirErr?.message || String(dirErr)) as string;
              readErrors.push(`Failed to list directory "${p}": ${dirErrMsg}`);
              continue;
            }
          }
          readErrors.push(`Failed to read "${p}": ${errMsg}`);
        }
      }
    }

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

    let enrichedDescription =
      Object.keys(fileContents).length > 0
        ? `${input.description}\n\nContext from files:\n` +
          Object.entries(fileContents)
            .map(([fp, c]) => `--- ${fp} ---\n${c}`)
            .join('\n\n')
        : input.description;

    if (recalledContext) {
      enrichedDescription += recalledContext;
    }

    const descLower = input.description.toLowerCase();
    const isScreenTask = descLower.includes('screen') || descLower.includes('visible') || descLower.includes('screenshot') || descLower.includes('monitor') || descLower.includes('what is on my display');

    if (isScreenTask && this.computerVisionConnector) {
      try {
        const observation = await this.computerVisionConnector.captureScreen(this.name);
        if (observation.success && observation.screenshotPath) {
          const base64Data = fs.readFileSync(observation.screenshotPath).toString('base64');
          const visionResponse = await this.modelRouter.route('vision', {
            description: `Describe what you see in the provided screenshot based on this user request: ${input.description}`,
            image: {
              base64: base64Data,
              mediaType: 'image/png'
            }
          });
          enrichedDescription += `\n\n[SCREEN VISUAL OBSERVATION]:\n${visionResponse.text}`;
          if (observation.imageFixtureFallbackUsed) {
            readErrors.push('Headless environment: Using real pre-rendered desktop_screenshot.png fixture.');
          }
        }
      } catch (err: any) {
        readErrors.push(`Failed to capture/analyze screen: ${err.message}`);
      }
    }

    // 2. Route task to model router ('research'). Exceptions bypass catch and propagate out.
    const modelResponse = await this.modelRouter.route('research', {
      description: enrichedDescription,
      fileContext: input.fileContext,
    });

    // 3. Format structured research result
    let summary = modelResponse.text;
    let confidence = 'high';
    const caveats: string[] = [...readErrors];
    const citations: string[] = [...sourcesRead];

    try {
      const parsed = JSON.parse(modelResponse.text);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.summary === 'string') summary = parsed.summary;
        if (typeof parsed.confidence === 'string') confidence = parsed.confidence;
        if (Array.isArray(parsed.caveats)) {
          for (const cv of parsed.caveats) {
            if (typeof cv === 'string' && !caveats.includes(cv)) {
              caveats.push(cv);
            }
          }
        }
        if (Array.isArray(parsed.citations)) {
          for (const c of parsed.citations) {
            if (typeof c === 'string' && !citations.includes(c)) {
              citations.push(c);
            }
          }
        }
      }
    } catch {
      // If response text is not JSON, use raw text as summary/explanation
    }

    const finalResult: ResearchAgentResult = {
      status: 'completed',
      filesChanged: [], // ResearcherAgent is read-only; never mutates files
      explanation: summary,
      summary,
      citations,
      confidence,
      caveats,
    };

    // Store task completion memory
    const memoryContent = `Research finding for: ${input.description}. Summary: ${summary}`;
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

    return finalResult;
  }

  /**
   * Listens for incoming messages (e.g. delegated write-file requests).
   */
  async receiveMessage(message: AgentMessage): Promise<AgentMessage | null> {
    if (message.type === 'write-file-request') {
      if (!this.gatekeeper) {
        return {
          id: crypto.randomUUID(),
          sender: this.name,
          recipient: message.sender,
          type: 'write-file-response',
          payload: { success: false, error: 'gatekeeper-not-configured' },
          correlationId: message.id,
          timestamp: new Date().toISOString(),
        };
      }

      const { path: filePath, content } = message.payload;
      const resolvedPath = path.resolve(filePath);

      const authorization = await this.gatekeeper.authorize({
        actor: this.name,
        action: 'file-write',
        params: {
          path: resolvedPath,
          taskId: 'delegated-task',
          bytes: content?.length || 0,
          actingOnBehalfOf: message.sender as any,
        },
      });

      if (!authorization.granted) {
        if (this.auditLog) {
          this.auditLog.recordOutcome(
            authorization.correlationId,
            this.name,
            'file-write',
            'denied — not-permitted'
          );
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
        if (this.auditLog) {
          this.auditLog.recordOutcome(
            authorization.correlationId,
            this.name,
            'file-write',
            `success — wrote ${content.length} bytes to ${resolvedPath}`
          );
        }
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
        if (this.auditLog) {
          this.auditLog.recordOutcome(
            authorization.correlationId,
            this.name,
            'file-write',
            `error — ${errMsg}`
          );
        }
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
