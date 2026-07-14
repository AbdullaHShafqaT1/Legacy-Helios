import { Logger } from 'pino';
import { AuditLog } from './auditLog.js';
import { redactSecrets } from '../lib/redact.js';

export type GuardedAction = 'file-write' | 'file-delete';

export interface PermissionRequest {
  actor: string;
  action: GuardedAction;
  params: {
    path: string;
    [key: string]: unknown;
  };
}

export interface PermissionDecision {
  granted: boolean;
  correlationId: string;
}

export type ApprovalPrompt = (request: PermissionRequest) => Promise<boolean>;

/**
 * Standard default ApprovalPrompt that always rejects requests.
 * Used for non-interactive execution or default fallback testing.
 */
export const denyAllPrompt: ApprovalPrompt = async () => false;

export class PermissionGatekeeper {
  private auditLog: AuditLog;
  private logger: Logger;
  private approvalPrompt: ApprovalPrompt;

  constructor(auditLog: AuditLog, logger: Logger, approvalPrompt: ApprovalPrompt) {
    this.auditLog = auditLog;
    this.logger = logger;
    this.approvalPrompt = approvalPrompt;
  }

  /**
   * Authorizes a resource action, logging decisions and triggering human-in-the-loop prompts if needed.
   *
   * @param request Permission parameters describing the actor, action, and target parameters.
   * @returns Resolves to a PermissionDecision holding the granted status and audit correlation ID.
   */
  async authorize(request: PermissionRequest): Promise<PermissionDecision> {
    let approved = false;

    try {
      approved = await this.approvalPrompt(request);
    } catch (error) {
      // Redact error trace arguments before passing to warn log
      const redactedError = redactSecrets(error);
      this.logger.warn(
        { error: redactedError, requestActor: request.actor, requestAction: request.action },
        'Approval prompt threw an error. Defaulting to deny-by-default.'
      );
      approved = false;
    }

    const correlationId = this.auditLog.recordDecision({
      actor: request.actor,
      action: request.action,
      params: request.params,
      approvalStatus: approved ? 'granted' : 'denied',
      approver: 'user'
    });

    if (approved) {
      this.logger.info(
        { correlationId, actor: request.actor, action: request.action, path: request.params.path },
        'Permission request GRANTED.'
      );
    } else {
      this.logger.warn(
        { correlationId, actor: request.actor, action: request.action, path: request.params.path },
        'Permission request DENIED.'
      );
    }

    return {
      granted: approved,
      correlationId
    };
  }
}
