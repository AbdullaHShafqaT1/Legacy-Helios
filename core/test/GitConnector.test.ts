import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { GitConnector } from '../../connectors/git/GitConnector.js';

describe('GitConnector Class', () => {
  let tempDir: string;
  let db: any;
  let auditLog: AuditLog;
  let logger: any;
  let mockPrompt: any;
  let mockHighFrictionPrompt: any;
  let gatekeeper: PermissionGatekeeper;
  let connector: GitConnector;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-git-test-'));
    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });

    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('git-test-logger', 'silent');
    mockPrompt = vi.fn().mockResolvedValue(true);
    mockHighFrictionPrompt = vi.fn().mockResolvedValue(true);

    gatekeeper = new PermissionGatekeeper(
      auditLog,
      logger,
      mockPrompt,
      undefined,
      mockHighFrictionPrompt
    );
    connector = new GitConnector({
      projectRoot: tempDir,
      gatekeeper,
      auditLog,
      logger,
    });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should inspect repo status without calling Gatekeeper authorize()', async () => {
    const authorizeSpy = vi.spyOn(gatekeeper, 'authorize');
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content');

    const result = await connector.status('software-engineer');
    expect(result.success).toBe(true);
    expect(result.branch).toBeDefined();
    expect(result.files).toHaveLength(1);
    expect(result.files?.[0].path).toBe('file.txt');
    expect(result.files?.[0].status).toBe('untracked');

    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it('should inspect commit log and diff without calling Gatekeeper authorize()', async () => {
    const authorizeSpy = vi.spyOn(gatekeeper, 'authorize');

    // On an empty repo without commits, log returns success with empty array
    const emptyLog = await connector.log('software-engineer');
    expect(emptyLog.success).toBe(true);
    expect(emptyLog.commits).toHaveLength(0);

    // Create a commit
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'initial');
    await connector.commit('software-engineer', 'Initial commit');

    const logResult = await connector.log('software-engineer');
    expect(logResult.success).toBe(true);
    expect(logResult.commits).toHaveLength(1);
    expect(logResult.commits?.[0].message).toBe('Initial commit');
    expect(logResult.commits?.[0].author).toBe('Test User');

    // Modify file and check diff
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'modified');
    const diffResult = await connector.diff('software-engineer');
    expect(diffResult.success).toBe(true);
    expect(diffResult.diff).toContain('-initial');
    expect(diffResult.diff).toContain('+modified');

    // authorizeSpy was called once for commit(), but never for log() or diff()
    expect(authorizeSpy).toHaveBeenCalledTimes(1);
  });

  it('should stage and commit changes when authorized via action git-operation', async () => {
    fs.writeFileSync(path.join(tempDir, 'work.txt'), 'done');

    const result = await connector.commit('software-engineer', 'Add work.txt');
    expect(result.success).toBe(true);
    expect(result.hash).toBeDefined();
    expect(result.correlationId).toBeDefined();

    const statusAfter = await connector.status('software-engineer');
    expect(statusAfter.files).toHaveLength(0);

    // Verify audit log outcome
    const recent = auditLog.recent();
    expect(recent[0].event_type).toBe('outcome');
    expect(recent[0].outcome).toContain('success — committed changes');
  });

  it('should return nothing-to-commit structured error when committing with no changes', async () => {
    // Commit once
    fs.writeFileSync(path.join(tempDir, 'clean.txt'), 'clean');
    await connector.commit('software-engineer', 'First');

    // Attempt second commit with no changes
    const result = await connector.commit('software-engineer', 'Second');
    expect(result.success).toBe(false);
    expect(result.error).toBe('nothing-to-commit');
    expect(result.explanation).toContain('No changes staged or available to commit');
  });

  it('should return remote-not-found structured error when pushing without configured remote', async () => {
    fs.writeFileSync(path.join(tempDir, 'push_me.txt'), 'push');
    await connector.commit('software-engineer', 'Ready to push');

    const result = await connector.push('software-engineer', 'origin', 'HEAD');
    expect(result.success).toBe(false);
    expect(result.error).toBe('remote-not-found');
    expect(result.explanation).toContain('No valid Git remote configured');

    const recent = auditLog.recent();
    expect(recent[0].event_type).toBe('outcome');
    expect(recent[0].outcome).toContain('error —');
  });

  it('should route forcePush through Gatekeeper with action git-force-push and reject when high-friction confirmation fails', async () => {
    fs.writeFileSync(path.join(tempDir, 'f.txt'), 'force');
    await connector.commit('software-engineer', 'Force target');

    // Simulate standard prompt returning false (e.g., user entered plain "y" on a high-friction prompt)
    mockHighFrictionPrompt.mockResolvedValue(false);

    const result = await connector.forcePush('software-engineer', 'origin', 'HEAD', '--force-with-lease');
    expect(result.success).toBe(false);
    expect(result.error).toBe('permission-denied');

    // Verify it invoked highFrictionPrompt via Gatekeeper routing
    expect(mockHighFrictionPrompt).toHaveBeenCalledTimes(1);

    const recent = auditLog.recent();
    expect(recent[0].outcome).toContain('denied');
  });

  it('should route resetHard through Gatekeeper with action git-history-rewrite and execute on approval', async () => {
    fs.writeFileSync(path.join(tempDir, 'state1.txt'), '1');
    const c1 = await connector.commit('software-engineer', 'Commit 1');
    const firstHash = c1.hash!;

    fs.writeFileSync(path.join(tempDir, 'state2.txt'), '2');
    await connector.commit('software-engineer', 'Commit 2');

    // Now reset --hard to first commit
    const result = await connector.resetHard('software-engineer', firstHash);
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(tempDir, 'state2.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'state1.txt'))).toBe(true);

    expect(mockHighFrictionPrompt).toHaveBeenCalledTimes(1);
    const recent = auditLog.recent();
    expect(recent[0].outcome).toContain(`success — reset --hard to ${firstHash}`);
  });

  it('should block unpermitted roles (researcher) at Step 1 of Gatekeeper without calling prompt', async () => {
    fs.writeFileSync(path.join(tempDir, 'research.txt'), 'notes');

    // researcher role only has file-read allowed in DEFAULT_AGENT_POLICIES
    const result = await connector.commit('researcher', 'Researcher attempt');
    expect(result.success).toBe(false);
    expect(result.error).toBe('permission-denied');

    // Verify neither prompt was called
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockHighFrictionPrompt).not.toHaveBeenCalled();

    const recent = auditLog.recent();
    expect(recent[0].outcome).toBe('denied — not-permitted');
    expect(recent[1].approver).toBe('system');
  });

  it('should return not-a-git-repo structured error when called on a non-git directory', async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-non-git-'));
    try {
      const nonGitConnector = new GitConnector({
        projectRoot: nonGitDir,
        gatekeeper,
        auditLog,
        logger,
      });

      const result = await nonGitConnector.status('software-engineer');
      expect(result.success).toBe(false);
      expect(result.error).toBe('not-a-git-repo');
      expect(result.explanation).toContain('not a valid Git repository');
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
