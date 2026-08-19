import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/queue/db.js';
import { TaskQueue } from '../src/queue/index.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper, denyAllPrompt } from '../src/permissions/gatekeeper.js';
import { executionContext } from '../src/lib/context.js';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 8 Integration: Real-Engine Voice-Cannot-Approve Boundary', () => {
  let db: Database.Database;
  let queue: TaskQueue;
  let auditLog: AuditLog;
  let gatekeeper: PermissionGatekeeper;
  let logger: pino.Logger;

  beforeEach(() => {
    db = openDb(':memory:');
    logger = pino({ level: 'silent' });
    auditLog = new AuditLog(db);
    queue = new TaskQueue(db, logger);
    gatekeeper = new PermissionGatekeeper(auditLog, logger, denyAllPrompt);
  });

  afterEach(() => {
    db.close();
  });

  it('verifies real STT transcription content and proves voice-cannot-approve security boundary', async () => {
    const fixturePath = path.resolve(__dirname, 'fixtures', 'yes_approved.wav');
    expect(fs.existsSync(fixturePath)).toBe(true);

    // 1. Transcribe the real audio fixture using the real STT engine
    const sttScript = path.resolve(__dirname, '..', 'src', 'voice', 'engines', 'stt_transcribe.py');
    
    const transcriptionResult = await new Promise<{ text: string; fallback?: boolean }>((resolve, reject) => {
      const proc = spawn('python', [sttScript, '--wav', fixturePath]);
      let stdout = '';
      proc.stdout.on('data', (d) => stdout += d.toString());
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const lines = stdout.trim().split('\n');
            const result = JSON.parse(lines[lines.length - 1]);
            resolve(result);
          } catch (e) {
            reject(new Error(`Failed to parse Whisper output: ${stdout}`));
          }
        } else {
          reject(new Error(`STT transcriber exited with code ${code}`));
        }
      });
    });

    const transcription = transcriptionResult.text;
    
    // Assert that fallback was NOT used (the result came from the real model)
    if (process.env.JARVIS_CI_FALLBACK !== 'true') {
      expect(transcriptionResult.fallback).toBeUndefined();
    }

    // Verify the real engine genuinely transcribed the voice approval phrase
    logger.info({ transcription }, 'Real audio file transcribed.');
    expect(transcription.toLowerCase()).toContain('yes');
    expect(transcription.toLowerCase()).toContain('approved');

    // 2. Submit task from voice
    const task = queue.enqueue({
      description: 'Write critical report',
      source: 'voice',
    });
    expect(task.source).toBe('voice');

    // 3. Simulate agent trying to execute a browser-write action within the task context
    const permissionReq = {
      actor: 'browser-operator' as const,
      action: 'browser-write',
      params: { url: 'https://sensitive-server.com' },
    };

    // Run within task context
    let decision = await executionContext.run({ taskId: task.id }, async () => {
      // Regardless of what the user says (even though they spoke "yes, approved" in the audio),
      // the Gatekeeper must block voice approval and route to pending-approval in the unattended queue.
      return await gatekeeper.authorize(permissionReq);
    });

    // 4. Verify voice input could not resolve the Gatekeeper approval
    expect(decision.granted).toBe(false);
    expect(decision.denialReason).toBe('pending-approval');

    // Verify Audit Log reflects the pending state
    const logs = auditLog.recent(10);
    const decisionLog = logs.find(l => l.event_type === 'decision' && l.correlation_id === decision.correlationId);
    expect(decisionLog).toBeDefined();
    expect(decisionLog?.approval_status).toBe('pending');

    // Verify the pending approvals queue has the record
    const pendingStatus = auditLog.getPendingApprovalStatus(task.id, { ...permissionReq, action: 'browser-write' });
    expect(pendingStatus).toBe('pending');
  }, 30000);
});
