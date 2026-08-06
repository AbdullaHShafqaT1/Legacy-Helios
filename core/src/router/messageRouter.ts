import { Logger } from 'pino';
import { AuditLog } from '../permissions/auditLog.js';
import { AgentRouter } from './agentRouter.js';
import { EventEmitter } from 'node:events';

export interface Message {
  id: string;
  sender: string;
  recipient: string;
  type: string;
  payload: any;
  correlationId?: string;
  actingOnBehalfOf?: string;
  timestamp: string;
  hops?: string[];
}

export class MessageRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageRouterError';
    Object.setPrototypeOf(this, MessageRouterError.prototype);
  }
}

export class MessageLoopError extends MessageRouterError {
  constructor(message: string) {
    super(message);
    this.name = 'MessageLoopError';
    Object.setPrototypeOf(this, MessageLoopError.prototype);
  }
}

export class MessageRouter {
  private agentRouter: AgentRouter;
  private auditLog: AuditLog;
  private logger: Logger;
  private emitter = new EventEmitter();
  private maxHops: number;
  private messageTimeoutMs: number;

  constructor(
    agentRouter: AgentRouter,
    auditLog: AuditLog,
    logger: Logger,
    maxHops = 10,
    messageTimeoutMs = 10000
  ) {
    this.agentRouter = agentRouter;
    this.auditLog = auditLog;
    this.logger = logger;
    this.maxHops = maxHops;
    this.messageTimeoutMs = messageTimeoutMs;
  }

  /**
   * Routes a message from sender to recipient.
   */
  async send(message: Message): Promise<Message | null> {
    this.validateMessage(message);

    const hops = message.hops || [];
    if (hops.includes(message.recipient)) {
      const errorMsg = `Message loop detected: ${hops.join(' -> ')} -> ${message.recipient}`;
      this.logger.error({ hops, recipient: message.recipient }, 'Message loop detected.');
      throw new MessageLoopError(errorMsg);
    }
    if (hops.length >= this.maxHops) {
      const errorMsg = `Max message hops reached (${this.maxHops}): ${hops.join(' -> ')}`;
      this.logger.error({ hops, maxHops: this.maxHops }, 'Max message hops exceeded.');
      throw new MessageLoopError(errorMsg);
    }

    const nextHops = [...hops, message.sender];
    const messageToDeliver: Message = {
      ...message,
      hops: nextHops,
    };

    // 1. Audit log message send event (decision before execution)
    const correlationId = this.auditLog.recordDecision({
      actor: message.sender,
      action: 'message-send',
      params: {
        id: message.id,
        recipient: message.recipient,
        type: message.type,
        actingOnBehalfOf: message.actingOnBehalfOf,
        correlationId: message.correlationId,
      },
      approvalStatus: 'granted',
      approver: 'system',
    });

    this.logger.info(
      { messageId: message.id, sender: message.sender, recipient: message.recipient, type: message.type },
      'Routing agent-to-agent message.'
    );

    // 2. Resolve recipient agent
    const recipientAgent = this.agentRouter.getAgent(message.recipient);
    if (!recipientAgent) {
      const errorMsg = `Recipient agent "${message.recipient}" is not registered.`;
      this.auditLog.recordOutcome(correlationId, message.sender, 'message-send', `error — ${errorMsg}`);
      throw new MessageRouterError(errorMsg);
    }

    // 3. Deliver message to recipient agent's receiveMessage hook
    try {
      if (!recipientAgent.receiveMessage) {
        const errorMsg = `Recipient agent "${message.recipient}" does not support receiveMessage.`;
        this.auditLog.recordOutcome(correlationId, message.sender, 'message-send', `error — ${errorMsg}`);
        throw new MessageRouterError(errorMsg);
      }

      const response = await recipientAgent.receiveMessage(messageToDeliver);
      
      this.auditLog.recordOutcome(
        correlationId,
        message.sender,
        'message-send',
        response ? `success — received reply type "${response.type}"` : 'success — message delivered'
      );

      // If there is a response, emit it to waiting listeners
      if (response) {
        this.emitter.emit(`reply:${response.correlationId || response.id}`, response);
      }

      return response;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.auditLog.recordOutcome(correlationId, message.sender, 'message-send', `error — ${errMsg}`);
      throw err;
    }
  }

  /**
   * Sends a message and waits for a response with a matching correlation ID.
   */
  async sendAndReceive(message: Message): Promise<Message> {
    const correlationId = message.id;
    const eventKey = `reply:${correlationId}`;

    const promise = new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.emitter.off(eventKey, handler);
        reject(new MessageRouterError(`Message delivery timeout: agent "${message.recipient}" did not respond within ${this.messageTimeoutMs}ms.`));
      }, this.messageTimeoutMs);

      const handler = (reply: Message) => {
        clearTimeout(timeout);
        resolve(reply);
      };

      this.emitter.once(eventKey, handler);
    });

    await this.send(message);
    return promise;
  }

  private validateMessage(message: Message): void {
    if (!message.id) throw new MessageRouterError('Message ID is required.');
    if (!message.sender) throw new MessageRouterError('Message sender is required.');
    if (!message.recipient) throw new MessageRouterError('Message recipient is required.');
    if (!message.type) throw new MessageRouterError('Message type is required.');
    if (!message.timestamp) throw new MessageRouterError('Message timestamp is required.');
  }
}
