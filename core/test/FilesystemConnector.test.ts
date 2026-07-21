import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import {
  FilesystemConnector,
  PathTraversalError,
  FileNotFoundError,
} from '../../connectors/filesystem/FilesystemConnector.js';

describe('FilesystemConnector Class', () => {
  let tempDir: string;
  let db: any;
  let auditLog: AuditLog;
  let logger: any;
  let mockPrompt: any;
  let gatekeeper: PermissionGatekeeper;
  let connector: FilesystemConnector;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fs-test-'));
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('fs-test-logger', 'silent');
    mockPrompt = vi.fn().mockResolvedValue(true);

    gatekeeper = new PermissionGatekeeper(auditLog, logger, mockPrompt);
    connector = new FilesystemConnector({
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

  it('should list directory contents within the project root', async () => {
    fs.writeFileSync(path.join(tempDir, 'file1.txt'), 'hello');
    fs.mkdirSync(path.join(tempDir, 'subfolder'));

    const items = await connector.listDir('software-engineer', '.');
    expect(items).toHaveLength(2);

    const fileItem = items.find((i) => i.name === 'file1.txt');
    expect(fileItem).toBeDefined();
    expect(fileItem?.isFile).toBe(true);
    expect(fileItem?.size).toBe(5);

    const dirItem = items.find((i) => i.name === 'subfolder');
    expect(dirItem).toBeDefined();
    expect(dirItem?.isDirectory).toBe(true);
  });

  it('should read file contents within the project root', async () => {
    const filePath = path.join(tempDir, 'read_test.txt');
    fs.writeFileSync(filePath, 'sample content text');

    const content = await connector.readFile('software-engineer', 'read_test.txt');
    expect(content).toBe('sample content text');
  });

  it('should throw FileNotFoundError when reading a missing file', async () => {
    await expect(connector.readFile('software-engineer', 'nonexistent.txt')).rejects.toThrow(
      FileNotFoundError
    );
  });

  it('should write a file when Gatekeeper grants write permission', async () => {
    mockPrompt.mockResolvedValue(true);

    const result = await connector.writeFile('software-engineer', 'written.txt', 'new file content');
    expect(result.success).toBe(true);
    expect(result.correlationId).toBeDefined();
    expect(fs.readFileSync(path.join(tempDir, 'written.txt'), 'utf8')).toBe('new file content');

    // Check audit log
    const recent = auditLog.recent();
    expect(recent).toHaveLength(2); // decision + outcome
    expect(recent[0].event_type).toBe('outcome');
    expect(recent[0].outcome).toContain('success — wrote 16 bytes');
  });

  it('should return failure status when Gatekeeper denies write permission', async () => {
    mockPrompt.mockResolvedValue(false);

    const result = await connector.writeFile('software-engineer', 'denied_write.txt', 'blocked text');
    expect(result.success).toBe(false);
    expect(result.error).toBe('permission-denied');
    expect(fs.existsSync(path.join(tempDir, 'denied_write.txt'))).toBe(false);

    const recent = auditLog.recent();
    expect(recent[0].event_type).toBe('outcome');
    expect(recent[0].outcome).toContain('denied');
  });

  it('should delete a file when Gatekeeper grants delete permission', async () => {
    const targetFile = path.join(tempDir, 'to_delete.txt');
    fs.writeFileSync(targetFile, 'delete me');

    mockPrompt.mockResolvedValue(true);

    const result = await connector.deleteFile('software-engineer', 'to_delete.txt');
    expect(result.success).toBe(true);
    expect(fs.existsSync(targetFile)).toBe(false);

    const recent = auditLog.recent();
    expect(recent[0].event_type).toBe('outcome');
    expect(recent[0].outcome).toContain('success — deleted file');
  });

  it('should reject relative path traversal attempts with ../.. and log audit security violation', async () => {
    await expect(connector.readFile('software-engineer', '../../outside.txt')).rejects.toThrow(
      PathTraversalError
    );

    // Verify security violation was logged to audit log
    const recent = auditLog.recent();
    expect(recent).toHaveLength(2);
    expect(recent[1].event_type).toBe('decision');
    expect(recent[1].approval_status).toBe('denied');
    expect(recent[1].approver).toBe('system');

    expect(recent[0].event_type).toBe('outcome');
    expect(recent[0].outcome).toContain('path traversal attempt rejected');
  });

  it('should reject absolute path attempts outside the project root and log audit security violation', async () => {
    const outsidePath = path.resolve(tempDir, '..', 'external.txt');

    await expect(connector.readFile('software-engineer', outsidePath)).rejects.toThrow(
      PathTraversalError
    );

    const recent = auditLog.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0].outcome).toContain('path traversal attempt rejected');
  });

  it('should surface Gatekeeper role rejection when an agent role (researcher) attempts a write', async () => {
    // 'researcher' role only has 'file-read' in allowedActions
    const result = await connector.writeFile('researcher', 'research_write.txt', 'data');

    expect(result.success).toBe(false);
    expect(result.error).toBe('permission-denied');
    expect(result.explanation).toContain('not-permitted');
    expect(fs.existsSync(path.join(tempDir, 'research_write.txt'))).toBe(false);

    // Verify Gatekeeper prompt was NOT called and decision was logged as system denial
    expect(mockPrompt).not.toHaveBeenCalled();

    const recent = auditLog.recent();
    expect(recent).toHaveLength(2);
    expect(recent[1].approval_status).toBe('denied');
    expect(recent[1].approver).toBe('system');
    expect(recent[0].outcome).toBe('denied — not-permitted');
  });
});
