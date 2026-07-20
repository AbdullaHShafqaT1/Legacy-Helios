import { Logger } from 'pino';
import { AuditLog } from './auditLog.js';
import { redactSecrets } from '../lib/redact.js';
import { TimeoutError, createHighFrictionApprovalPrompt } from '../lib/prompt.js';
import {
  GuardedAction,
  AgentPolicy,
  PolicyMap,
  DEFAULT_AGENT_POLICIES,
} from './policy.js';

export { GuardedAction, AgentPolicy, PolicyMap, DEFAULT_AGENT_POLICIES };

export interface PermissionRequest {
  actor: string;
  action: GuardedAction | string;
  params: {
    path?: string;
    [key: string]: unknown;
  };
}

export interface PermissionDecision {
  granted: boolean;
  correlationId: string;
  denialReason?: 'not-permitted' | 'explicit' | 'timeout' | 'error';
  approver?: 'system' | 'user' | 'policy';
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
  private policyMap: PolicyMap;
  private highFrictionPrompt: ApprovalPrompt;

  constructor(
    auditLog: AuditLog,
    logger: Logger,
    approvalPrompt: ApprovalPrompt,
    policyMap: PolicyMap = DEFAULT_AGENT_POLICIES,
    highFrictionPrompt?: ApprovalPrompt
  ) {
    this.auditLog = auditLog;
    this.logger = logger;
    this.approvalPrompt = approvalPrompt;
    this.policyMap = policyMap;
    this.highFrictionPrompt = highFrictionPrompt || createHighFrictionApprovalPrompt();
  }

  /**
   * Authorizes a resource action via a mandatory 2-step verification pipeline:
   * 1. Role-Based Check: Validates if the actor is permitted to attempt this action category.
   * 2. Approval Check: Policy pre-approval for read actions, or interactive/high-friction prompt.
   *
   * @param request Permission parameters describing the actor, action, and target parameters.
   * @returns Resolves to a PermissionDecision holding the granted status and audit correlation ID.
   */
  async authorize(request: PermissionRequest): Promise<PermissionDecision> {
    const policy = this.policyMap[request.actor];

    // STEP 1: Role-based check
    // An agent with no policy entry or attempting an action outside its allowedActions must be rejected immediately.
    const isRoleAllowed = Boolean(policy && policy.allowedActions.includes(request.action as GuardedAction));

    if (!isRoleAllowed) {
      const correlationId = this.auditLog.recordDecision({
        actor: request.actor,
        action: request.action,
        params: request.params,
        approvalStatus: 'denied',
        approver: 'system',
      });

      this.logger.warn(
        { correlationId, actor: request.actor, action: request.action, denialReason: 'not-permitted' },
        'Permission request DENIED: Actor is not permitted to perform this action category.'
      );

      return {
        granted: false,
        correlationId,
        denialReason: 'not-permitted',
        approver: 'system',
      };
    }

    // STEP 2: Approval check
    // Step 2a: Policy Pre-approval (auto-approve non-destructive passive read actions)
    const isAutoApproved = Boolean(
      policy.autoApproveActions && policy.autoApproveActions.includes(request.action as GuardedAction)
    );

    if (isAutoApproved) {
      const correlationId = this.auditLog.recordDecision({
        actor: request.actor,
        action: request.action,
        params: request.params,
        approvalStatus: 'granted',
        approver: 'policy',
      });

      this.logger.info(
        { correlationId, actor: request.actor, action: request.action, approver: 'policy' },
        'Permission request GRANTED via policy pre-approval.'
      );

      return {
        granted: true,
        correlationId,
        approver: 'policy',
      };
    }

    // Step 2b: Interactive / High-Friction Prompt check
    const isHighFriction = ['git-force-push', 'git-history-rewrite', 'destructive'].includes(request.action);
    const promptToUse = isHighFriction ? this.highFrictionPrompt : this.approvalPrompt;

    let approved = false;
    let denialReason: 'explicit' | 'timeout' | 'error' | undefined;

    try {
      approved = await promptToUse(request);
      if (!approved) {
        denialReason = 'explicit';
      }
    } catch (error: any) {
      if (error instanceof TimeoutError) {
        approved = false;
        denialReason = 'timeout';
      } else {
        // Redact error trace arguments before passing to warn log
        const redactedError = redactSecrets(error);
        this.logger.warn(
          { error: redactedError, requestActor: request.actor, requestAction: request.action },
          'Approval prompt threw an error. Defaulting to deny-by-default.'
        );
        approved = false;
        denialReason = 'error';
      }
    }

    const correlationId = this.auditLog.recordDecision({
      actor: request.actor,
      action: request.action,
      params: request.params,
      approvalStatus: approved ? 'granted' : 'denied',
      approver: 'user',
    });

    if (approved) {
      this.logger.info(
        { correlationId, actor: request.actor, action: request.action, path: request.params.path },
        'Permission request GRANTED.'
      );
    } else {
      this.logger.warn(
        { correlationId, actor: request.actor, action: request.action, path: request.params.path, denialReason },
        'Permission request DENIED.'
      );
    }

    return {
      granted: approved,
      correlationId,
      denialReason,
      approver: 'user',
    };
  }
}
