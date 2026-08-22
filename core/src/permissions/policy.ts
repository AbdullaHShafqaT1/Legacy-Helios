export type GuardedAction =
  | 'file-read'
  | 'file-write'
  | 'file-delete'
  | 'git-operation'
  | 'git-force-push'
  | 'git-history-rewrite'
  | 'destructive'
  | 'memory-write'
  | 'memory-read'
  | 'kanban-write'
  | 'browser-read'
  | 'browser-write'
  | 'browser-admin'
  | 'terminal-run'
  | 'vision-read'
  | 'vision-periodic-start'
  | 'web-search'
  | 'desktop-mouse'
  | 'desktop-keyboard'
  | 'desktop-admin';

export type AgentRole =
  | 'software-engineer'
  | 'researcher'
  | 'code-reviewer'
  | 'project-manager'
  | 'browser-operator'
  | 'terminal-operator'
  | 'system'; // 'system' is used as an approver sometimes

export interface AgentPolicy {
  allowedActions: (GuardedAction | string)[];
  autoApproveActions?: (GuardedAction | string)[];
}

export type PolicyMap = Record<string, AgentPolicy>;

/**
 * Default role-based policies for Jarvis agents.
 *
 * DESIGN DECISION: Conservative Auto-Approval
 * Only passive, read-only operations ('file-read', 'memory-read', 'vision-read', 'web-search') are eligible for policy-level auto-approval.
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
      'vision-read',
      'vision-periodic-start',
      'web-search',
      'desktop-mouse',
      'desktop-keyboard',
      'desktop-admin',
    ],
    autoApproveActions: ['file-read', 'memory-read', 'vision-read'],
  },
  'researcher': {
    allowedActions: ['file-read', 'memory-read', 'memory-write', 'vision-read', 'vision-periodic-start', 'web-search'],
    autoApproveActions: ['file-read', 'memory-read', 'vision-read', 'web-search'],
  },
  'code-reviewer': {
    allowedActions: ['file-read', 'memory-read', 'memory-write'],
    autoApproveActions: ['file-read', 'memory-read'],
  },
  'project-manager': {
    allowedActions: ['memory-read', 'memory-write', 'kanban-write'],
    autoApproveActions: ['memory-read', 'kanban-write'],
  },
  'browser-operator': {
    allowedActions: ['browser-read', 'browser-write', 'memory-read', 'memory-write', 'vision-read', 'vision-periodic-start', 'web-search', 'desktop-mouse'],
    autoApproveActions: ['browser-read', 'memory-read', 'vision-read'],
  },
  'terminal-operator': {
    allowedActions: ['terminal-run', 'memory-read', 'memory-write', 'vision-read', 'vision-periodic-start', 'web-search', 'desktop-mouse', 'desktop-keyboard'],
    autoApproveActions: ['memory-read', 'vision-read'],
  },
  'system': {
    allowedActions: ['memory-write', 'memory-read', 'vision-read'],
    autoApproveActions: ['memory-write', 'memory-read', 'vision-read'],
  },
};
