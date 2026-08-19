import crypto from 'node:crypto';
import { Logger } from 'pino';
import { AuditLog } from './auditLog.js';
import { redactSecrets } from '../lib/redact.js';
import { TimeoutError, createHighFrictionApprovalPrompt } from '../lib/prompt.js';
import { loadConfig } from '../lib/config.js';
import type {
  GuardedAction,
  AgentPolicy,
  PolicyMap,
  AgentRole,
} from './policy.js';
import { DEFAULT_AGENT_POLICIES } from './policy.js';
import { executionContext } from '../lib/context.js';

export { GuardedAction, AgentPolicy, PolicyMap, DEFAULT_AGENT_POLICIES, AgentRole };

export interface PermissionRequest {
  actor: AgentRole;
  action: GuardedAction | string;
  params: {
    path?: string;
    actingOnBehalfOf?: AgentRole;
    [key: string]: unknown;
  };
}

export interface PermissionDecision {
  granted: boolean;
  correlationId: string;
  denialReason?: 'not-permitted' | 'explicit' | 'timeout' | 'error' | 'pending-approval';
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
    const config = loadConfig(false);
    let action = request.action;

    // Check for browser URL restrictions
    if (action === 'browser-read' || action === 'browser-write') {
      const urlParam = request.params.url as string;
      if (urlParam) {
        const isLocal = isLocalOrFileUrl(urlParam);
        const isAllowed = isUrlAllowlisted(urlParam, config.browserLocalAllowlist);
        if (isLocal && !isAllowed) {
          action = 'browser-admin'; // force higher risk category that is blocked by default
        }
      }
    }

    const policy = this.policyMap[request.actor];

    // STEP 1: Role-based check
    // An agent with no policy entry or attempting an action outside its allowedActions must be rejected immediately.
    const isRoleAllowed = Boolean(policy && policy.allowedActions.includes(action as GuardedAction));

    if (!isRoleAllowed) {
      const correlationId = this.auditLog.recordRequest({
        actor: request.actor,
        action: action,
        params: request.params,
      });

      this.auditLog.recordDecision({
        correlationId,
        actor: request.actor,
        action: action,
        params: request.params,
        approvalStatus: 'denied',
        approver: 'system',
      });

      this.logger.warn(
        { correlationId, actor: request.actor, action: action, denialReason: 'not-permitted' },
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
    let isAutoApproved = Boolean(
      policy.autoApproveActions && policy.autoApproveActions.includes(action as GuardedAction)
    );

    // Terminal command allow-list pre-approval logic
    if (action === 'terminal-run') {
      const command = request.params.command as string;
      const isCmdAllowed = config.terminalAllowlist.some(allowedCmd => {
        const trimmedAllowed = allowedCmd.trim();
        if (trimmedAllowed.endsWith('*')) {
          const prefix = trimmedAllowed.slice(0, -1).trim();
          return command === prefix || command.startsWith(prefix + ' ');
        } else {
          return command.trim() === trimmedAllowed;
        }
      });
      if (isCmdAllowed) {
        isAutoApproved = true;
      }
    }

    // 1. Record the request FIRST
    const correlationId = this.auditLog.recordRequest({
      actor: request.actor,
      action: request.action as string,
      params: request.params
    });

    const finish = (granted: boolean, denialReason?: PermissionDecision['denialReason'], approver?: PermissionDecision['approver']): PermissionDecision => {
      this.auditLog.recordDecision({
        correlationId,
        actor: request.actor,
        action: request.action as string,
        params: request.params,
        approvalStatus: denialReason === 'pending-approval' ? 'pending' : (granted ? 'granted' : 'denied'),
        approver: approver || null
      });
      return { granted, correlationId, denialReason, approver };
    };

    if (isAutoApproved) {
      this.logger.info(
        { correlationId, actor: request.actor, action: action, approver: 'policy' },
        'Permission request GRANTED via policy pre-approval.'
      );
      return finish(true, undefined, 'policy');
    }

    // Step 2b: Interactive / High-Friction Prompt check
    const context = executionContext.getStore();
    const taskSource = context?.taskId ? this.auditLog.getTaskSource(context.taskId) : null;
    const isUnattendedMode = config.unattended || taskSource === 'voice';

    if (isUnattendedMode && context && context.taskId) {
      const payload = { ...request, action };
      const pendingStatus = this.auditLog.getPendingApprovalStatus(context.taskId, payload);

      if (pendingStatus === 'granted') {
        this.logger.info(
          { correlationId, actor: request.actor, action: action, approver: 'user' },
          'Permission request GRANTED via Unattended Approval Queue.'
        );
        return finish(true, undefined, 'user');
      } else if (pendingStatus === 'denied') {
        return finish(false, 'explicit', 'user');
      } else {
        // 'pending' or null (not requested yet)
        if (pendingStatus !== 'pending') {
           this.auditLog.recordPendingApproval(correlationId, context.taskId, payload);
           this.logger.info(
             { correlationId, actor: request.actor, action: action, taskId: context.taskId },
             'Permission request queued for Unattended Approval.'
           );
        }
        return finish(false, 'pending-approval', 'system');
      }
    }

    const isHighFriction = ['git-force-push', 'git-history-rewrite', 'destructive', 'terminal-run'].includes(action);
    const promptToUse = isHighFriction ? this.highFrictionPrompt : this.approvalPrompt;

    let approved = false;
    let denialReason: 'explicit' | 'timeout' | 'error' | undefined;

    try {
      approved = await promptToUse({
        ...request,
        action,
      });
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
        this.logger.warn({ error: redactedError }, 'Approval prompt encountered an error.');
        approved = false;
        denialReason = 'error';
      }
    }

    if (approved) {
      this.logger.info(
        { correlationId, actor: request.actor, action: action, approver: 'user' },
        'Permission request GRANTED by user.'
      );
      return finish(true, undefined, 'user');
    } else {
      this.logger.info(
        { correlationId, actor: request.actor, action: action, denialReason, approver: 'user' },
        'Permission request DENIED.'
      );
      return finish(false, denialReason, 'user');
    }
  }
}

function isLocalOrFileUrl(urlString: string): boolean {
  if (!urlString) return false;
  const trimmed = urlString.trim().toLowerCase();
  if (trimmed.startsWith('file:')) {
    return true;
  }
  try {
    const url = new URL(urlString);
    if (url.protocol === 'file:') return true;
    const hostname = url.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '0.0.0.0'
    ) {
      return true;
    }
    const parts = hostname.split('.');
    if (parts.length === 4) {
      const p1 = parseInt(parts[0], 10);
      const p2 = parseInt(parts[1], 10);
      if (p1 === 10) return true;
      if (p1 === 192 && p2 === 168) return true;
      if (p1 === 172 && p2 >= 16 && p2 <= 31) return true;
      if (p1 === 127) return true;
    }
  } catch {
    if (trimmed.includes('localhost') || trimmed.includes('127.0.0.1') || trimmed.includes('[::1]')) {
      return true;
    }
  }
  return false;
}

function isUrlAllowlisted(urlString: string, allowlist: string[]): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;
    return allowlist.includes(hostname) || allowlist.includes(url.host);
  } catch {
    return false;
  }
}
