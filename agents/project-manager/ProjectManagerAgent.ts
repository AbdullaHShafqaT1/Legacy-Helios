import crypto from 'node:crypto';
import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult, AgentMessage } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { KanbanConnector } from '../../connectors/kanban/KanbanConnector.js';
import { TaskQueue } from '../../core/src/queue/index.js';
import { MessageRouter } from '../../core/src/router/messageRouter.js';

export class ProjectManagerAgent implements Agent {
  readonly name = 'project-manager';
  private readonly modelRouter: ModelRouter;
  private readonly kanbanConnector: KanbanConnector;
  private readonly taskQueue: TaskQueue;
  private readonly messageRouter: MessageRouter;
  private readonly logger: Logger;

  constructor(
    modelRouter: ModelRouter,
    kanbanConnector: KanbanConnector,
    taskQueue: TaskQueue,
    messageRouter: MessageRouter,
    logger: Logger
  ) {
    this.modelRouter = modelRouter;
    this.kanbanConnector = kanbanConnector;
    this.taskQueue = taskQueue;
    this.messageRouter = messageRouter;
    this.logger = logger;
  }

  /**
   * Process a PM task directly (e.g. CLI status query task enqueued).
   */
  async process(input: AgentTaskInput): Promise<AgentResult> {
    this.logger.info({ taskId: input.taskId }, 'ProjectManager processing task.');
    const report = this.kanbanConnector.getBoardStatus();
    return {
      status: 'completed',
      filesChanged: [],
      explanation: report,
    };
  }

  /**
   * EventBus callbacks to update Kanban board columns.
   */

  async handleTaskCreated(data: { taskId: string }): Promise<void> {
    this.logger.info({ taskId: data.taskId }, 'ProjectManager handleTaskCreated.');
    const task = this.taskQueue.getById(data.taskId);
    if (!task) return;

    try {
      // Ensure default board is initialized
      await this.kanbanConnector.initDefaultBoard(this.name);

      await this.kanbanConnector.createCard(this.name, {
        id: crypto.randomUUID(),
        columnId: 'todo',
        taskId: task.id,
        title: task.description,
        status: 'Todo',
      });
    } catch (err: any) {
      this.logger.error({ err: err?.message, taskId: data.taskId }, 'Failed to create Kanban card for task.');
    }
  }

  async handleTaskStarted(data: { taskId: string; agent: string }): Promise<void> {
    this.logger.info({ taskId: data.taskId }, 'ProjectManager handleTaskStarted.');
    const card = this.kanbanConnector.getCardByTaskId(data.taskId);
    if (!card) return;

    try {
      await this.kanbanConnector.moveCard(this.name, {
        cardId: card.id,
        columnId: 'in-progress',
        status: 'In Progress',
      });
    } catch (err: any) {
      this.logger.error({ err: err?.message, taskId: data.taskId }, 'Failed to update card to In Progress.');
    }
  }

  async handleTaskCompleted(data: { taskId: string }): Promise<void> {
    this.logger.info({ taskId: data.taskId }, 'ProjectManager handleTaskCompleted.');
    const card = this.kanbanConnector.getCardByTaskId(data.taskId);
    if (!card) return;

    try {
      // Move to review column
      await this.kanbanConnector.moveCard(this.name, {
        cardId: card.id,
        columnId: 'review',
        status: 'Review',
      });
    } catch (err: any) {
      this.logger.error({ err: err?.message, taskId: data.taskId }, 'Failed to update card to Review.');
    }
  }

  async handleTaskFailed(data: { taskId: string; error: string; willRetry: boolean }): Promise<void> {
    this.logger.info({ taskId: data.taskId }, 'ProjectManager handleTaskFailed.');
    const card = this.kanbanConnector.getCardByTaskId(data.taskId);
    if (!card) return;

    try {
      // If it will retry, set back to todo or leave in progress with error note.
      // If exhausted, mark failed
      await this.kanbanConnector.moveCard(this.name, {
        cardId: card.id,
        columnId: data.willRetry ? 'todo' : 'in-progress',
        status: data.willRetry ? 'Failed (Will Retry)' : 'Failed (Permanent)',
      });
    } catch (err: any) {
      this.logger.error({ err: err?.message, taskId: data.taskId }, 'Failed to update card status on task failure.');
    }
  }

  /**
   * Listen for incoming messages.
   */
  async receiveMessage(message: AgentMessage): Promise<AgentMessage | null> {
    if (message.type === 'review-result') {
      const { taskId, verdict, explanation } = message.payload;
      this.logger.info({ taskId, verdict }, 'ProjectManager received review result.');

      const card = this.kanbanConnector.getCardByTaskId(taskId);
      if (!card) {
        this.logger.warn({ taskId }, 'No Kanban card found for reviewed task.');
        return null;
      }

      if (verdict === 'approved') {
        try {
          await this.kanbanConnector.moveCard(this.name, {
            cardId: card.id,
            columnId: 'done',
            status: 'Completed',
          });
        } catch (err: any) {
          this.logger.error({ err: err?.message, cardId: card.id }, 'Failed to move card to done.');
        }
      } else {
        // Changes requested! Move card back to in-progress and requeue task in queue
        try {
          await this.kanbanConnector.moveCard(this.name, {
            cardId: card.id,
            columnId: 'in-progress',
            status: 'Changes Requested',
          });

          // Sensible reconciliation: reset task to pending status in queue
          this.taskQueue.requeue(taskId, `Review rejected: ${explanation || 'Changes requested.'}`);
        } catch (err: any) {
          this.logger.error({ err: err?.message, taskId }, 'Failed to requeue task after review rejection.');
        }
      }

      return {
        id: crypto.randomUUID(),
        sender: this.name,
        recipient: message.sender,
        type: 'status-update',
        payload: { success: true },
        correlationId: message.id,
        timestamp: new Date().toISOString(),
      };
    }

    if (message.type === 'status-request') {
      const report = this.kanbanConnector.getBoardStatus();
      return {
        id: crypto.randomUUID(),
        sender: this.name,
        recipient: message.sender,
        type: 'status-report',
        payload: { report },
        correlationId: message.id,
        timestamp: new Date().toISOString(),
      };
    }

    return null;
  }
}
