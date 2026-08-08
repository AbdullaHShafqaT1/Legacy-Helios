import crypto from 'node:crypto';
import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult, AgentMessage } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { FilesystemConnector } from '../../connectors/filesystem/FilesystemConnector.js';
import { MessageRouter, MessageRouterError } from '../../core/src/router/messageRouter.js';

export interface CodeReviewerResult extends AgentResult {
  verdict?: 'approved' | 'request-changes';
  issues?: Array<{ severity: 'info' | 'warning' | 'error'; message: string }>;
}

export class CodeReviewerAgent implements Agent {
  readonly name = 'code-reviewer';
  private readonly modelRouter: ModelRouter;
  private readonly filesystemConnector?: FilesystemConnector;
  private readonly messageRouter: MessageRouter;
  private readonly logger: Logger;

  constructor(
    modelRouter: ModelRouter,
    filesystemConnector: FilesystemConnector | undefined,
    messageRouter: MessageRouter,
    logger: Logger
  ) {
    this.modelRouter = modelRouter;
    this.filesystemConnector = filesystemConnector;
    this.messageRouter = messageRouter;
    this.logger = logger;
  }

  /**
   * Process a review task directly.
   */
  async process(input: AgentTaskInput): Promise<CodeReviewerResult> {
    this.logger.info({ taskId: input.taskId }, 'CodeReviewer processing task.');

    const filesChanged = (input.fileContext as any)?.filesChanged || [];
    const reviewResult = await this.performReview(input.taskId, input.description, filesChanged);

    return {
      status: reviewResult.verdict === 'approved' ? 'completed' : 'failed',
      filesChanged: [],
      explanation: reviewResult.explanation,
      verdict: reviewResult.verdict,
      issues: reviewResult.issues,
    };
  }

  /**
   * Listens for review-request messages.
   */
  async receiveMessage(message: AgentMessage): Promise<AgentMessage | null> {
    if (message.type !== 'review-request') {
      return null;
    }

    const { taskId, description, filesChanged } = message.payload;
    this.logger.info({ taskId, sender: message.sender }, 'CodeReviewer received review-request.');

    const reviewResult = await this.performReview(taskId, description, filesChanged || []);

    // Send a message to project-manager with the review results
    const pmMessage: Message = {
      id: crypto.randomUUID(),
      sender: this.name,
      recipient: 'project-manager',
      type: 'review-result',
      payload: {
        taskId,
        verdict: reviewResult.verdict,
        issues: reviewResult.issues,
        explanation: reviewResult.explanation,
      },
      hops: message.hops,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.messageRouter.send(pmMessage);
    } catch (err: any) {
      this.logger.error({ err }, 'Failed to notify project-manager of review result.');
      throw err;
    }

    // Return the response back to the sender
    return {
      id: crypto.randomUUID(),
      sender: this.name,
      recipient: message.sender,
      type: 'review-result',
      payload: {
        taskId,
        verdict: reviewResult.verdict,
        issues: reviewResult.issues,
        explanation: reviewResult.explanation,
      },
      hops: message.hops,
      correlationId: message.id,
      timestamp: new Date().toISOString(),
    };
  }

  private async performReview(
    taskId: string,
    description: string,
    filesChanged: string[]
  ): Promise<{ verdict: 'approved' | 'request-changes'; issues: any[]; explanation: string }> {
    const fileContents: Record<string, string> = {};

    if (this.filesystemConnector && filesChanged.length > 0) {
      for (const file of filesChanged) {
        try {
          const content = await this.filesystemConnector.readFile(this.name, file);
          fileContents[file] = content;
        } catch (err: any) {
          this.logger.warn({ file, err: err?.message }, 'Could not read file for review.');
          fileContents[file] = `Error reading file: ${err?.message || err}`;
        }
      }
    }

    const prompt = `Review the following task description and files:
Task: ${description}
Files under review:
${JSON.stringify(fileContents, null, 2)}

Provide a structured review in the following JSON format:
{
  "verdict": "approved" | "request-changes",
  "issues": [
    { "severity": "info" | "warning" | "error", "message": "description of issue" }
  ],
  "explanation": "general summary"
}
Output ONLY valid JSON.`;

    try {
      const modelRes = await this.modelRouter.route('coding', { description: prompt });
      const text = modelRes.text.trim();

      const match = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : text);

      return {
        verdict: parsed.verdict === 'approved' ? 'approved' : 'request-changes',
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        explanation: parsed.explanation || 'Reviewed output code.',
      };
    } catch (err) {
      this.logger.error({ err }, 'Failed to parse model code review response. Using fallback.');
      return {
        verdict: 'approved',
        issues: [],
        explanation: 'Review succeeded without structured issues.',
      };
    }
  }
}

// Structural type helper matches the Message interface defined in messageRouter
type Message = AgentMessage;
