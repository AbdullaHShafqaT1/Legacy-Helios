import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ApprovalPrompt } from '../permissions/gatekeeper.js';
import { loadConfig } from './config.js';

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Creates an ApprovalPrompt that queries the user via the terminal standard input.
 * Includes a configurable timeout after which it rejects with a TimeoutError.
 *
 * DESIGN DECISION: Non-Interactive Environments Fallback (Deny by default)
 * Stdin blocking requires an interactive TTY. If process.stdin is not a TTY (such as in headless CI,
 * background services, or tests), standard input reading cannot block, and we fail safe by returning false
 * immediately. This is a design constraint for Phase 1.
 */
export function createStdinApprovalPrompt(): ApprovalPrompt {
  return async (request) => {
    // If not a TTY (non-interactive environment), deny by default
    if (!input.isTTY) {
      return false;
    }

    const config = loadConfig(false);
    const timeoutMs = config.approvalTimeoutMs ?? 30000;

    const rl = readline.createInterface({ input, output });
    let timeoutId: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TimeoutError('Interactive terminal prompt timed out.'));
      }, timeoutMs);
    });

    try {
      const message = `
========================================
PERMISSION REQUESTED
Actor:  ${request.actor}
Action: ${request.action}
Path:   ${request.params.path}
========================================
Approve? (y/N): `;

      const answerPromise = rl.question(message);
      const answer = await Promise.race([answerPromise, timeoutPromise]);

      return answer.trim().toLowerCase() === 'y';
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      rl.close();
    }
  };
}

function getRequiredPhraseForAction(action: string): string {
  switch (action) {
    case 'git-force-push':
      return 'CONFIRM FORCE PUSH';
    case 'git-history-rewrite':
      return 'CONFIRM REWRITE HISTORY';
    case 'destructive':
      return 'CONFIRM DESTRUCTIVE ACTION';
    default:
      return 'CONFIRM HIGH RISK ACTION';
  }
}

/**
 * Creates a high-friction ApprovalPrompt requiring the user to type a specific confirmation phrase.
 * A plain 'y' or 'yes' response will NOT approve the action — the exact confirmation phrase must match.
 */
export function createHighFrictionApprovalPrompt(requiredPhrase?: string): ApprovalPrompt {
  return async (request) => {
    // If not a TTY (non-interactive environment), deny by default
    if (!input.isTTY) {
      return false;
    }

    const config = loadConfig(false);
    const timeoutMs = config.approvalTimeoutMs ?? 30000;

    const expectedPhrase = requiredPhrase ?? getRequiredPhraseForAction(request.action);

    const rl = readline.createInterface({ input, output });
    let timeoutId: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TimeoutError('High-friction terminal prompt timed out.'));
      }, timeoutMs);
    });

    try {
      const message = `
========================================
HIGH-FRICTION PERMISSION REQUESTED
Actor:  ${request.actor}
Action: ${request.action}
Path:   ${request.params.path ?? 'N/A'}
WARNING: This is a high-risk operation!
To approve, type EXACTLY: "${expectedPhrase}"
========================================
Confirmation: `;

      const answerPromise = rl.question(message);
      const answer = await Promise.race([answerPromise, timeoutPromise]);

      return answer.trim() === expectedPhrase;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      rl.close();
    }
  };
}
