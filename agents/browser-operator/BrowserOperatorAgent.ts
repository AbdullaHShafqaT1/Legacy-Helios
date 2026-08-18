import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult, AgentMessage, deriveProjectTag } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { BrowserConnector } from '../../connectors/browser/BrowserConnector.js';
import { MemoryManager } from '../../core/src/memory/memoryManager.js';
import { MessageRouter } from '../../core/src/router/messageRouter.js';
import crypto from 'node:crypto';

export class BrowserOperatorAgent implements Agent {
  readonly name = 'browser-operator';
  private readonly modelRouter: ModelRouter;
  private readonly browserConnector: BrowserConnector;
  private readonly memoryManager: MemoryManager;
  private readonly logger: Logger;
  private readonly messageRouter?: MessageRouter;

  constructor(
    modelRouter: ModelRouter,
    browserConnector: BrowserConnector,
    memoryManager: MemoryManager,
    logger: Logger,
    messageRouter?: MessageRouter
  ) {
    this.modelRouter = modelRouter;
    this.browserConnector = browserConnector;
    this.memoryManager = memoryManager;
    this.logger = logger;
    this.messageRouter = messageRouter;
  }

  async process(input: AgentTaskInput): Promise<AgentResult> {
    const tag = deriveProjectTag(input);
    const fileContext = input.fileContext as Record<string, any> | undefined;
    const url = fileContext?.url || '';

    try {
      if (url) {
        await this.browserConnector.navigate(this.name, url);
        const text = await this.browserConnector.readContent(this.name);
        
        // Store memory
        const memoryContent = `Browser visited ${url} and retrieved content: ${text.substring(0, 200)}...`;
        await this.memoryManager.store({
          content: memoryContent,
          sourceAgent: this.name,
          sourceTaskId: input.taskId,
          tag,
        });

        return {
          status: 'completed',
          filesChanged: [],
          explanation: `Successfully navigated to ${url} and read content.`,
        };
      }

      // If no explicit URL, use the model router to determine what to do
      const response = await this.modelRouter.route('reasoning', {
        description: `Browser operator received task: ${input.description}. Parse out what URL to visit. Return JSON with format {"url": "..."}`,
        fileContext: input.fileContext,
      });

      let targetUrl = '';
      try {
        const parsed = JSON.parse(response.text);
        targetUrl = parsed.url;
      } catch {
        // Fallback or pattern matching
        const match = response.text.match(/https?:\/\/[^\s]+/);
        if (match) {
          targetUrl = match[0];
        }
      }

      if (!targetUrl) {
        return {
          status: 'failed',
          filesChanged: [],
          explanation: 'Could not extract a valid URL to visit from the task description.',
        };
      }

      await this.browserConnector.navigate(this.name, targetUrl);
      const text = await this.browserConnector.readContent(this.name);

      return {
        status: 'completed',
        filesChanged: [],
        explanation: `Visited ${targetUrl}. Body: ${text.substring(0, 500)}`,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        filesChanged: [],
        explanation: `Browser operation failed: ${err.message || err}`,
        error: err.message || String(err),
      };
    }
  }

  async receiveMessage(message: AgentMessage): Promise<AgentMessage | null> {
    if (message.type.startsWith('browser-')) {
      const payload = message.payload;
      const actingOnBehalfOf = message.sender as any;

      try {
        if (message.type === 'browser-navigate') {
          await this.browserConnector.navigate(this.name, payload.url, actingOnBehalfOf);
          return {
            id: crypto.randomUUID(),
            sender: this.name,
            recipient: message.sender,
            type: 'browser-navigate-response',
            payload: { success: true },
            correlationId: message.id,
            timestamp: new Date().toISOString(),
          };
        }

        if (message.type === 'browser-read') {
          const content = await this.browserConnector.readContent(this.name, actingOnBehalfOf);
          return {
            id: crypto.randomUUID(),
            sender: this.name,
            recipient: message.sender,
            type: 'browser-read-response',
            payload: { success: true, content },
            correlationId: message.id,
            timestamp: new Date().toISOString(),
          };
        }

        if (message.type === 'browser-click') {
          await this.browserConnector.click(this.name, payload.selector, actingOnBehalfOf);
          return {
            id: crypto.randomUUID(),
            sender: this.name,
            recipient: message.sender,
            type: 'browser-click-response',
            payload: { success: true },
            correlationId: message.id,
            timestamp: new Date().toISOString(),
          };
        }

        if (message.type === 'browser-fill') {
          await this.browserConnector.fill(this.name, payload.selector, payload.value, actingOnBehalfOf);
          return {
            id: crypto.randomUUID(),
            sender: this.name,
            recipient: message.sender,
            type: 'browser-fill-response',
            payload: { success: true },
            correlationId: message.id,
            timestamp: new Date().toISOString(),
          };
        }

        if (message.type === 'browser-download') {
          const path = await this.browserConnector.download(this.name, payload.url, actingOnBehalfOf);
          return {
            id: crypto.randomUUID(),
            sender: this.name,
            recipient: message.sender,
            type: 'browser-download-response',
            payload: { success: true, path },
            correlationId: message.id,
            timestamp: new Date().toISOString(),
          };
        }

        if (message.type === 'browser-upload') {
          await this.browserConnector.upload(this.name, payload.selector, payload.filePath, actingOnBehalfOf);
          return {
            id: crypto.randomUUID(),
            sender: this.name,
            recipient: message.sender,
            type: 'browser-upload-response',
            payload: { success: true },
            correlationId: message.id,
            timestamp: new Date().toISOString(),
          };
        }
      } catch (err: any) {
        return {
          id: crypto.randomUUID(),
          sender: this.name,
          recipient: message.sender,
          type: `${message.type}-response`,
          payload: { success: false, error: err.message || String(err) },
          correlationId: message.id,
          timestamp: new Date().toISOString(),
        };
      }
    }
    return null;
  }
}
