import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Logger } from 'pino';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { redactSecrets } from '../../core/src/lib/redact.js';

const execFileAsync = promisify(execFile);

export interface GitStatusItem {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'other';
  code: string;
  staged: boolean;
}

export interface GitStatusResult {
  success: boolean;
  branch?: string;
  files?: GitStatusItem[];
  error?: string;
  explanation?: string;
}

export interface GitCommitItem {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitLogResult {
  success: boolean;
  commits?: GitCommitItem[];
  error?: string;
  explanation?: string;
}

export interface GitDiffResult {
  success: boolean;
  diff?: string;
  error?: string;
  explanation?: string;
}

export interface GitOperationResult {
  success: boolean;
  correlationId?: string;
  error?: string;
  explanation?: string;
  hash?: string;
  [key: string]: unknown;
}

export interface GitConnectorOptions {
  projectRoot: string;
  gatekeeper: PermissionGatekeeper;
  auditLog: AuditLog;
  logger: Logger;
}

export class GitConnector {
  private readonly projectRoot: string;
  private readonly gatekeeper: PermissionGatekeeper;
  private readonly auditLog: AuditLog;
  private readonly logger: Logger;

  constructor(options: GitConnectorOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.logger = options.logger;
  }

  /**
   * Returns the normalized absolute repository/project root path.
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Safely invokes the `git` CLI using `execFile` with an argument array to prevent shell injection.
   */
  private async execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, { cwd: this.projectRoot });
  }

  /**
   * Classifies Git CLI command errors into structured, human-readable error messages
   * without raw stderr dumps.
   */
  private classifyGitError(err: any): { error: string; explanation: string } {
    const stdout = String(err?.stdout || '');
    const stderr = String(err?.stderr || '');
    const message = String(err?.message || '');
    const combined = `${stderr}\n${stdout}\n${message}`;

    if (
      combined.includes('not a git repository') ||
      combined.includes('fatal: not a git repository')
    ) {
      return {
        error: 'not-a-git-repo',
        explanation: 'Target directory is not a valid Git repository.',
      };
    }

    if (
      combined.includes('nothing to commit') ||
      combined.includes('nothing added to commit') ||
      combined.includes('no changes added to commit')
    ) {
      return {
        error: 'nothing-to-commit',
        explanation: 'No changes staged or available to commit.',
      };
    }

    if (
      combined.includes('CONFLICT') ||
      combined.includes('Automatic merge failed') ||
      combined.includes('unmerged files')
    ) {
      return {
        error: 'merge-conflict',
        explanation: 'Git command failed due to a merge conflict that must be resolved manually.',
      };
    }

    if (
      combined.includes('No configured push destination') ||
      combined.includes('does not appear to be a git repository') ||
      combined.includes('Could not read from remote repository') ||
      combined.includes('No such remote') ||
      combined.includes("'origin' does not appear to be a git repository")
    ) {
      return {
        error: 'remote-not-found',
        explanation: 'No valid Git remote configured or destination repository unreachable.',
      };
    }

    if (
      combined.includes('failed to push some refs') ||
      combined.includes('non-fast-forward') ||
      combined.includes('fetch first') ||
      combined.includes('stale info')
    ) {
      return {
        error: 'push-rejected',
        explanation:
          'Push rejected by remote repository (non-fast-forward or stale ref). Try fetching or force-pushing with lease.',
      };
    }

    if (
      combined.includes('not our ref') ||
      combined.includes('bad revision') ||
      combined.includes('unknown revision') ||
      combined.includes('ambiguous argument') ||
      combined.includes('src refspec') ||
      combined.includes('does not match any')
    ) {
      return {
        error: 'invalid-ref',
        explanation: 'The specified Git reference or revision is invalid or unknown.',
      };
    }

    let cleanMessage = stderr.trim() || message.trim() || 'Git command failed.';
    cleanMessage = cleanMessage
      .split('\n')[0]
      .replace(/^fatal:\s*/i, '')
      .replace(/^error:\s*/i, '')
      .trim();

    const redacted = redactSecrets(cleanMessage) as string;

    return {
      error: 'git-error',
      explanation: redacted || 'Git command failed with an unclassified error.',
    };
  }

  /**
   * Unrestricted Read: Returns current repository status (staged, unstaged, untracked files).
   */
  async status(_actor: string): Promise<GitStatusResult> {
    try {
      const { stdout } = await this.execGit(['status', '--porcelain', '-b']);
      const lines = stdout.split('\n').filter((l) => l.length > 0);
      let branch = 'HEAD';
      const files: GitStatusItem[] = [];

      for (const line of lines) {
        if (line.startsWith('## ')) {
          const branchLine = line.substring(3).trim();
          branch = branchLine.split('...')[0].split(' ')[0] || 'HEAD';
          continue;
        }

        if (line.length < 3) continue;
        const code = line.substring(0, 2);
        const filePath = line.substring(3).trim();

        const staged = code[0] !== ' ' && code[0] !== '?';

        let status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'other' = 'other';
        if (code === '??') {
          status = 'untracked';
        } else if (code.includes('M')) {
          status = 'modified';
        } else if (code.includes('A')) {
          status = 'added';
        } else if (code.includes('D')) {
          status = 'deleted';
        } else if (code.includes('R')) {
          status = 'renamed';
        }

        files.push({
          path: filePath,
          status,
          code,
          staged,
        });
      }

      return {
        success: true,
        branch,
        files,
      };
    } catch (err) {
      return {
        success: false,
        ...this.classifyGitError(err),
      };
    }
  }

  /**
   * Unrestricted Read: Returns commit history up to limit.
   */
  async log(_actor: string, limit = 10): Promise<GitLogResult> {
    try {
      const { stdout } = await this.execGit([
        'log',
        `-n`,
        String(limit),
        '--format=%H%x1f%an%x1f%aI%x1f%s',
      ]);

      const commits: GitCommitItem[] = stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parts = line.split('\x1f');
          return {
            hash: parts[0] || '',
            author: parts[1] || '',
            date: parts[2] || '',
            message: parts[3] || '',
          };
        });

      return {
        success: true,
        commits,
      };
    } catch (err: any) {
      const combined = `${err?.stderr || ''}\n${err?.message || ''}`;
      if (
        combined.includes('does not have any commits yet') ||
        combined.includes('bad default revision')
      ) {
        return {
          success: true,
          commits: [],
        };
      }
      return {
        success: false,
        ...this.classifyGitError(err),
      };
    }
  }

  /**
   * Unrestricted Read: Returns diff output for working tree or a given ref/path.
   */
  async diff(_actor: string, refOrPath?: string): Promise<GitDiffResult> {
    try {
      const args = ['diff'];
      if (refOrPath) {
        args.push(refOrPath);
      }
      const { stdout } = await this.execGit(args);
      return {
        success: true,
        diff: stdout,
      };
    } catch (err) {
      return {
        success: false,
        ...this.classifyGitError(err),
      };
    }
  }

  /**
   * Gated Write ('git-operation'): Stages all changes (by default) and creates a commit.
   */
  async commit(
    actor: string,
    message: string,
    options?: { all?: boolean }
  ): Promise<GitOperationResult> {
    const authorization = await this.gatekeeper.authorize({
      actor: actor as any,
      action: 'git-operation',
      params: {
        operation: 'commit',
        message,
        all: options?.all ?? true,
        projectRoot: this.projectRoot,
      },
    });

    if (!authorization.granted) {
      const outcomeText =
        authorization.denialReason === 'timeout'
          ? 'denied — timeout'
          : authorization.denialReason === 'not-permitted'
          ? 'denied — not-permitted'
          : 'denied — no write performed';

      this.auditLog.recordOutcome(authorization.correlationId, actor, 'git-operation', outcomeText);

      return {
        success: false,
        correlationId: authorization.correlationId,
        error: 'permission-denied',
        explanation: `Git commit denied by gatekeeper (${authorization.denialReason || 'denied'}).`,
      };
    }

    try {
      if (options?.all !== false) {
        await this.execGit(['add', '-A']);
      }

      await this.execGit(['commit', '-m', message]);
      const { stdout: revStdout } = await this.execGit(['rev-parse', 'HEAD']);
      const hash = revStdout.trim();

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-operation',
        `success — committed changes (${hash.substring(0, 7)})`
      );

      return {
        success: true,
        correlationId: authorization.correlationId,
        hash,
        explanation: `Successfully committed changes (${hash.substring(0, 7)})`,
      };
    } catch (err) {
      const errResult = this.classifyGitError(err);
      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-operation',
        `error — ${errResult.explanation}`
      );
      return {
        success: false,
        correlationId: authorization.correlationId,
        ...errResult,
      };
    }
  }

  /**
   * Gated Write ('git-operation'): Pushes commits to a remote repository.
   */
  async push(
    actor: string,
    remote = 'origin',
    branch?: string
  ): Promise<GitOperationResult> {
    const authorization = await this.gatekeeper.authorize({
      actor: actor as any,
      action: 'git-operation',
      params: {
        operation: 'push',
        remote,
        branch,
        projectRoot: this.projectRoot,
      },
    });

    if (!authorization.granted) {
      const outcomeText =
        authorization.denialReason === 'timeout'
          ? 'denied — timeout'
          : authorization.denialReason === 'not-permitted'
          ? 'denied — not-permitted'
          : 'denied — no write performed';

      this.auditLog.recordOutcome(authorization.correlationId, actor, 'git-operation', outcomeText);

      return {
        success: false,
        correlationId: authorization.correlationId,
        error: 'permission-denied',
        explanation: `Git push denied by gatekeeper (${authorization.denialReason || 'denied'}).`,
      };
    }

    try {
      const args = ['push', remote];
      if (branch) {
        args.push(branch);
      }
      await this.execGit(args);

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-operation',
        `success — pushed to ${remote} ${branch || ''}`.trim()
      );

      return {
        success: true,
        correlationId: authorization.correlationId,
        explanation: `Successfully pushed to ${remote} ${branch || ''}`.trim(),
      };
    } catch (err) {
      const errResult = this.classifyGitError(err);
      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-operation',
        `error — ${errResult.explanation}`
      );
      return {
        success: false,
        correlationId: authorization.correlationId,
        ...errResult,
      };
    }
  }

  /**
   * Destructive Operation ('git-force-push'): Pushes with force (defaults to --force-with-lease).
   * Automatically triggers Gatekeeper high-friction confirmation prompt.
   */
  async forcePush(
    actor: string,
    remote = 'origin',
    branch?: string,
    forceFlag: '--force' | '--force-with-lease' = '--force-with-lease'
  ): Promise<GitOperationResult> {
    const authorization = await this.gatekeeper.authorize({
      actor: actor as any,
      action: 'git-force-push',
      params: {
        operation: 'force-push',
        remote,
        branch,
        forceFlag,
        projectRoot: this.projectRoot,
      },
    });

    if (!authorization.granted) {
      const outcomeText =
        authorization.denialReason === 'timeout'
          ? 'denied — timeout'
          : authorization.denialReason === 'not-permitted'
          ? 'denied — not-permitted'
          : 'denied — no write performed';

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-force-push',
        outcomeText
      );

      return {
        success: false,
        correlationId: authorization.correlationId,
        error: 'permission-denied',
        explanation: `Git force push denied by gatekeeper (${authorization.denialReason || 'denied'}).`,
      };
    }

    try {
      const args = ['push', forceFlag, remote];
      if (branch) {
        args.push(branch);
      }
      await this.execGit(args);

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-force-push',
        `success — force-pushed (${forceFlag}) to ${remote} ${branch || ''}`.trim()
      );

      return {
        success: true,
        correlationId: authorization.correlationId,
        explanation: `Successfully force-pushed (${forceFlag}) to ${remote} ${branch || ''}`.trim(),
      };
    } catch (err) {
      const errResult = this.classifyGitError(err);
      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-force-push',
        `error — ${errResult.explanation}`
      );
      return {
        success: false,
        correlationId: authorization.correlationId,
        ...errResult,
      };
    }
  }

  /**
   * Destructive Operation ('git-history-rewrite'): Resets working tree and history to target ref.
   * Automatically triggers Gatekeeper high-friction confirmation prompt.
   */
  async resetHard(
    actor: string,
    targetRef = 'HEAD'
  ): Promise<GitOperationResult> {
    const authorization = await this.gatekeeper.authorize({
      actor: actor as any,
      action: 'git-history-rewrite',
      params: {
        operation: 'reset-hard',
        targetRef,
        projectRoot: this.projectRoot,
      },
    });

    if (!authorization.granted) {
      const outcomeText =
        authorization.denialReason === 'timeout'
          ? 'denied — timeout'
          : authorization.denialReason === 'not-permitted'
          ? 'denied — not-permitted'
          : 'denied — no write performed';

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-history-rewrite',
        outcomeText
      );

      return {
        success: false,
        correlationId: authorization.correlationId,
        error: 'permission-denied',
        explanation: `Git history rewrite (reset --hard) denied by gatekeeper (${authorization.denialReason || 'denied'}).`,
      };
    }

    try {
      await this.execGit(['reset', '--hard', targetRef]);

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-history-rewrite',
        `success — reset --hard to ${targetRef}`
      );

      return {
        success: true,
        correlationId: authorization.correlationId,
        explanation: `Successfully reset repository --hard to ${targetRef}`,
      };
    } catch (err) {
      const errResult = this.classifyGitError(err);
      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'git-history-rewrite',
        `error — ${errResult.explanation}`
      );
      return {
        success: false,
        correlationId: authorization.correlationId,
        ...errResult,
      };
    }
  }
}
