import fs from 'node:fs';
import path from 'node:path';
import { Logger } from 'pino';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
    Object.setPrototypeOf(this, PathTraversalError.prototype);
  }
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFoundError';
    Object.setPrototypeOf(this, FileNotFoundError.prototype);
  }
}

export interface DirectoryItem {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}

export interface FilesystemResult {
  success: boolean;
  path: string;
  correlationId?: string;
  error?: string;
  explanation?: string;
}

export interface FilesystemConnectorOptions {
  projectRoot: string;
  gatekeeper: PermissionGatekeeper;
  auditLog: AuditLog;
  logger: Logger;
}

export class FilesystemConnector {
  private readonly projectRoot: string;
  private readonly gatekeeper: PermissionGatekeeper;
  private readonly auditLog: AuditLog;
  private readonly logger: Logger;

  constructor(options: FilesystemConnectorOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.logger = options.logger;
  }

  /**
   * Returns the normalized absolute project root path.
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Validates and resolves a target path against the project root.
   * Enforces path traversal security (rejects relative escapes like `../../`,
   * absolute paths outside root, and symlink targets outside root).
   *
   * If scoping check fails, logs an audit decision + outcome pair flagged as a security violation
   * and throws a PathTraversalError.
   */
  private validateAndResolvePath(actor: string, actionName: string, targetPath: string): string {
    const resolvedTarget = path.resolve(this.projectRoot, targetPath);

    // Relative path check: Ensure relative path from projectRoot does not escape
    const relative = path.relative(this.projectRoot, resolvedTarget);
    const isOutside = relative.startsWith('..') || path.isAbsolute(relative);

    if (isOutside) {
      this.recordTraversalViolation(actor, actionName, targetPath, resolvedTarget);
      throw new PathTraversalError(
        `Path traversal violation rejected: Target path "${targetPath}" resolves to "${resolvedTarget}", which escapes project root "${this.projectRoot}".`
      );
    }

    // Symlink escape check: If the target (or existing parent) is a symlink, verify realpath is inside root
    if (fs.existsSync(resolvedTarget)) {
      try {
        const realTarget = fs.realpathSync(resolvedTarget);
        const realRelative = path.relative(this.projectRoot, realTarget);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
          this.recordTraversalViolation(actor, actionName, targetPath, realTarget);
          throw new PathTraversalError(
            `Symlink path traversal violation rejected: Real target path "${realTarget}" escapes project root "${this.projectRoot}".`
          );
        }
      } catch (err: any) {
        if (err instanceof PathTraversalError) {
          throw err;
        }
        // Ignore non-traversal errors during realpath check
      }
    }

    return resolvedTarget;
  }

  private recordTraversalViolation(actor: string, actionName: string, targetPath: string, resolvedTarget: string): void {
    const correlationId = this.auditLog.recordDecision({
      actor,
      action: actionName,
      params: { targetPath, resolvedTarget, projectRoot: this.projectRoot, violation: 'path-traversal-attempt' },
      approvalStatus: 'denied',
      approver: 'system',
    });

    this.auditLog.recordOutcome(
      correlationId,
      actor,
      actionName,
      `denied — path traversal attempt rejected (${targetPath})`
    );

    this.logger.warn(
      { actor, action: actionName, targetPath, resolvedTarget, projectRoot: this.projectRoot },
      'SECURITY VIOLATION: Path traversal attempt blocked.'
    );
  }

  /**
   * Lists contents (files and subdirectories) of a directory within the project root.
   * Calls Gatekeeper for role permission check ('file-read').
   */
  async listDir(actor: string, targetPath: string): Promise<DirectoryItem[]> {
    const resolvedPath = this.validateAndResolvePath(actor, 'file-read', targetPath);

    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'file-read',
      params: { path: resolvedPath },
    });

    if (!authorization.granted) {
      throw new Error(`Directory read permission denied for actor "${actor}": ${authorization.denialReason || 'denied'}`);
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new FileNotFoundError(`Directory not found at path "${targetPath}" (resolved: "${resolvedPath}")`);
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Target path "${targetPath}" is not a directory.`);
    }

    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
    return entries.map((entry) => {
      const entryPath = path.join(resolvedPath, entry.name);
      let size = 0;
      try {
        const entryStat = fs.statSync(entryPath);
        size = entryStat.size;
      } catch {
        // Ignore stat errors for special files
      }
      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size,
      };
    });
  }

  /**
   * Reads full file contents as a string within the project root.
   * Calls Gatekeeper for role permission check ('file-read').
   */
  async readFile(actor: string, targetPath: string): Promise<string> {
    const resolvedPath = this.validateAndResolvePath(actor, 'file-read', targetPath);

    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'file-read',
      params: { path: resolvedPath },
    });

    if (!authorization.granted) {
      throw new Error(`File read permission denied for actor "${actor}": ${authorization.denialReason || 'denied'}`);
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new FileNotFoundError(`File not found at path "${targetPath}" (resolved: "${resolvedPath}")`);
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.isDirectory()) {
      throw new Error(`Target path "${targetPath}" is a directory, not a file.`);
    }

    return fs.readFileSync(resolvedPath, 'utf8');
  }

  /**
   * Writes file contents to a path within the project root.
   * Routes operation through PermissionGatekeeper ('file-write') and records outcomes.
   */
  async writeFile(actor: string, targetPath: string, content: string): Promise<FilesystemResult> {
    const resolvedPath = this.validateAndResolvePath(actor, 'file-write', targetPath);

    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'file-write',
      params: { path: resolvedPath, bytes: content.length },
    });

    if (!authorization.granted) {
      const outcomeText =
        authorization.denialReason === 'timeout'
          ? 'denied — timeout'
          : authorization.denialReason === 'not-permitted'
          ? 'denied — not-permitted'
          : 'denied — no write performed';

      this.auditLog.recordOutcome(authorization.correlationId, actor, 'file-write', outcomeText);

      return {
        success: false,
        path: resolvedPath,
        correlationId: authorization.correlationId,
        error: 'permission-denied',
        explanation: `Write to path "${resolvedPath}" was denied by gatekeeper (${authorization.denialReason || 'denied'}).`,
      };
    }

    try {
      const parentDir = path.dirname(resolvedPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      fs.writeFileSync(resolvedPath, content, 'utf8');

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'file-write',
        `success — wrote ${content.length} bytes to ${resolvedPath}`
      );

      return {
        success: true,
        path: resolvedPath,
        correlationId: authorization.correlationId,
        explanation: `Successfully wrote ${content.length} bytes to ${resolvedPath}`,
      };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'file-write', `error — ${errorMsg}`);

      return {
        success: false,
        path: resolvedPath,
        correlationId: authorization.correlationId,
        error: errorMsg,
        explanation: `Failed to write file to ${resolvedPath}: ${errorMsg}`,
      };
    }
  }

  /**
   * Deletes a file at a path within the project root.
   * Routes operation through PermissionGatekeeper ('file-delete') and records outcomes.
   */
  async deleteFile(actor: string, targetPath: string): Promise<FilesystemResult> {
    const resolvedPath = this.validateAndResolvePath(actor, 'file-delete', targetPath);

    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'file-delete',
      params: { path: resolvedPath },
    });

    if (!authorization.granted) {
      const outcomeText =
        authorization.denialReason === 'timeout'
          ? 'denied — timeout'
          : authorization.denialReason === 'not-permitted'
          ? 'denied — not-permitted'
          : 'denied — no delete performed';

      this.auditLog.recordOutcome(authorization.correlationId, actor, 'file-delete', outcomeText);

      return {
        success: false,
        path: resolvedPath,
        correlationId: authorization.correlationId,
        error: 'permission-denied',
        explanation: `Delete at path "${resolvedPath}" was denied by gatekeeper (${authorization.denialReason || 'denied'}).`,
      };
    }

    if (!fs.existsSync(resolvedPath)) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'file-delete', 'error — file not found');
      return {
        success: false,
        path: resolvedPath,
        correlationId: authorization.correlationId,
        error: 'file-not-found',
        explanation: `File not found at path "${resolvedPath}" for deletion.`,
      };
    }

    try {
      fs.unlinkSync(resolvedPath);

      this.auditLog.recordOutcome(
        authorization.correlationId,
        actor,
        'file-delete',
        `success — deleted file ${resolvedPath}`
      );

      return {
        success: true,
        path: resolvedPath,
        correlationId: authorization.correlationId,
        explanation: `Successfully deleted file ${resolvedPath}`,
      };
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'file-delete', `error — ${errorMsg}`);

      return {
        success: false,
        path: resolvedPath,
        correlationId: authorization.correlationId,
        error: errorMsg,
        explanation: `Failed to delete file ${resolvedPath}: ${errorMsg}`,
      };
    }
  }
}
