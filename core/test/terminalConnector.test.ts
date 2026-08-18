import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/queue/db.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { createLogger } from '../src/lib/logger.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { TerminalConnector } from '../../connectors/terminal/TerminalConnector.js';
import { clearConfigCache } from '../src/lib/config.js';

describe('TerminalConnector Unit Tests', () => {
  let tempDir: string;
  let db: any;
  let auditLog: AuditLog;
  let logger: any;
  let gatekeeper: PermissionGatekeeper;
  let terminalConnector: TerminalConnector;
  let mockStandardPrompt: any;
  let mockHighFrictionPrompt: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-term-test-'));
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('terminal-test', 'silent');

    mockStandardPrompt = vi.fn().mockResolvedValue(true);
    mockHighFrictionPrompt = vi.fn().mockResolvedValue(true);

    gatekeeper = new PermissionGatekeeper(
      auditLog,
      logger,
      mockStandardPrompt,
      undefined,
      mockHighFrictionPrompt
    );

    terminalConnector = new TerminalConnector({
      projectRoot: tempDir,
      gatekeeper,
      auditLog,
      logger,
      timeoutMs: 1000, // short timeout for testing hang
    });

    process.env.JARVIS_TERMINAL_ALLOWLIST = 'ls,git status,npm test';
    process.env.JARVIS_PROJECT_ROOT = tempDir;
    clearConfigCache();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.JARVIS_TERMINAL_ALLOWLIST;
    delete process.env.JARVIS_PROJECT_ROOT;
    clearConfigCache();
  });

  it('should parse command strings with quotes and arguments correctly', () => {
    const parsed = terminalConnector.parseCommand('git commit -m "initial commit"');
    expect(parsed.command).toBe('git');
    expect(parsed.args).toEqual(['commit', '-m', 'initial commit']);
  });

  it('should reject commands attempting to escape project root directory scoping', async () => {
    const parentDir = path.dirname(tempDir);
    await expect(
      terminalConnector.execute('terminal-operator', 'ls', parentDir)
    ).rejects.toThrow('escapes project root');
  });

  it('should reject commands containing shell metacharacters to resist command injection', async () => {
    await expect(
      terminalConnector.execute('terminal-operator', 'ls && cat secrets.txt')
    ).rejects.toThrow('shell metacharacters detected');

    await expect(
      terminalConnector.execute('terminal-operator', 'ls; whoami')
    ).rejects.toThrow('shell metacharacters detected');
  });

  it('should auto-approve commands in the terminal allowlist', async () => {
    const mockAuth = vi.spyOn(gatekeeper, 'authorize');
    const result = await terminalConnector.execute('terminal-operator', 'ls');
    expect(mockAuth).toHaveBeenCalled();
    const callArg = mockAuth.mock.calls[0][0];
    expect(callArg.action).toBe('terminal-run');
    // Gatekeeper should grant it as policy/pre-approved
    const decision = await gatekeeper.authorize({
      actor: 'terminal-operator' as any,
      action: 'terminal-run',
      params: { command: 'ls' },
    });
    expect(decision.approver).toBe('policy');
    expect(decision.granted).toBe(true);
  });

  it('should route non-allowlisted commands to high-friction confirmation tier', async () => {
    mockHighFrictionPrompt.mockResolvedValue(true);
    const decision = await gatekeeper.authorize({
      actor: 'terminal-operator' as any,
      action: 'terminal-run',
      params: { command: 'rm -rf /' },
    });
    expect(decision.approver).toBe('user');
    expect(mockHighFrictionPrompt).toHaveBeenCalled();
  });

  it('should kill hanging process cleanly and return Process timed out', async () => {
    const scriptPath = path.join(tempDir, 'hang.js');
    fs.writeFileSync(scriptPath, 'setTimeout(() => {}, 10000);');

    const result = await terminalConnector.execute('terminal-operator', `node ${scriptPath}`);
    expect(result.error).toBe('Process timed out');
    expect(result.exitCode).toBeNull();
  });

  it('should redact secrets (like Anthropic API keys) from stdout and stderr output', async () => {
    const scriptPath = path.join(tempDir, 'secret.js');
    fs.writeFileSync(scriptPath, 'console.log("here is key sk-ant-abcdef1234567890abcdef1234567890abc");');

    const result = await terminalConnector.execute('terminal-operator', `node ${scriptPath}`);
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stdout).not.toContain('sk-ant-');
  });
});
