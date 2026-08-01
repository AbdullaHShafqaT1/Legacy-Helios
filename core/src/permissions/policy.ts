export type GuardedAction =
  | 'file-read'
  | 'file-write'
  | 'file-delete'
  | 'git-operation'
  | 'git-force-push'
  | 'git-history-rewrite'
  | 'destructive'
  | 'memory-write'
  | 'memory-read';

export interface AgentPolicy {
  allowedActions: (GuardedAction | string)[];
  autoApproveActions?: (GuardedAction | string)[];
}

export type PolicyMap = Record<string, AgentPolicy>;

/**
 * Default role-based policies for Jarvis agents.
 *
 * DESIGN DECISION: Conservative Auto-Approval
 * Only passive, read-only operations ('file-read', 'memory-read') are eligible for policy-level auto-approval.
 * All mutating actions ('file-write', 'file-delete', 'git-operation', 'memory-write') and all high-friction/destructive
 * categories ('git-force-push', 'git-history-rewrite', 'destructive') MUST NEVER be auto-approved
 * by policy and must strictly require human-in-the-loop authorization.
 */
export const DEFAULT_AGENT_POLICIES: PolicyMap = {
  'software-engineer': {
    allowedActions: [
      'file-read',
      'file-write',
      'file-delete',
      'git-operation',
      'git-force-push',
      'git-history-rewrite',
      'destructive',
      'memory-write',
      'memory-read',
    ],
    autoApproveActions: ['file-read', 'memory-read'],
  },
  'researcher': {
    allowedActions: ['file-read', 'memory-read'],
    autoApproveActions: ['file-read', 'memory-read'],
  },
};
