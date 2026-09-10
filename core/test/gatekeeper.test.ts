import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../src/queue/db.js';
import { createLogger } from '../src/lib/logger.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { PermissionGatekeeper, denyAllPrompt, PermissionRequest } from '../src/permissions/gatekeeper.js';
import { createStdinApprovalPrompt, createHighFrictionApprovalPrompt } from '../src/lib/prompt.js';
import { DEFAULT_AGENT_POLICIES } from '../src/permissions/policy.js';
import { stdin } from 'node:process';
import { clearConfigCache } from '../src/lib/config.js';

// Setup Mock for node:readline/promises default export
const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('node:readline/promises', () => {
  return {
    default: {
      createInterface: () => ({
        question: mockQuestion,
        close: mockClose,
      }),
    },
  };
});

describe('PermissionGatekeeper Class', () => {
  let db: any;
  let auditLog: AuditLog;
  let logger: any;
  let origEnvApprovalTimeout: string | undefined;
  let isTTYBackup: boolean | undefined;

  beforeEach(() => {
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('test-logger', 'silent');
    origEnvApprovalTimeout = process.env.JARVIS_APPROVAL_TIMEOUT_MS;
    isTTYBackup = stdin.isTTY;
    clearConfigCache();
  });

  afterEach(() => {
    db.close();
    if (origEnvApprovalTimeout !== undefined) {
      process.env.JARVIS_APPROVAL_TIMEOUT_MS = origEnvApprovalTimeout;
    } else {
      delete process.env.JARVIS_APPROVAL_TIMEOUT_MS;
    }
    Object.defineProperty(stdin, 'isTTY', {
      value: isTTYBackup,
      configurable: true,
      writable: true,
    });
    clearConfigCache();
  });

  it('should return granted=true when approvalPrompt resolves true for an allowed role', async () => {
    const mockPrompt = vi.fn().mockResolvedValue(true);
    const gatekeeper = new PermissionGatekeeper(auditLog, logger, mockPrompt);

    const request = {
      actor: 'software-engineer' as any,
      action: 'file-write' as const,
      params: { path: 'allowed.json' },
    };

    const decision = await gatekeeper.authorize(request);
    expect(decision.granted).toBe(true);
    expect(decision.correlationId).toBeDefined();

    // Verify decision exists in audit log
    const recent = auditLog.recent();
    const decisions = recent.filter(r => r.event_type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].correlation_id).toBe(decision.correlationId);
    expect(decisions[0].approval_status).toBe('granted');
  });

  it('should return granted=false when approvalPrompt resolves false', async () => {
    const gatekeeper = new PermissionGatekeeper(auditLog, logger, denyAllPrompt);

    const request = {
      actor: 'software-engineer' as any,
      action: 'file-delete' as const,
      params: { path: 'forbidden.json' },
    };

    const decision = await gatekeeper.authorize(request);
    expect(decision.granted).toBe(false);

    // Verify decision exists in audit log
    const recent = auditLog.recent();
    const decisions = recent.filter(r => r.event_type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].correlation_id).toBe(decision.correlationId);
    expect(decisions[0].approval_status).toBe('denied');
  });

  it('should swallow prompt exceptions, return granted=false, and log a warning while writing the decision', async () => {
    const errorMsg = 'Interactive terminal prompt disconnected';
    const mockPrompt = vi.fn().mockRejectedValue(new Error(errorMsg));

    const warnSpy = vi.fn();
    const mockLogger = {
      warn: warnSpy,
      info: vi.fn(),
    } as any;

    const gatekeeper = new PermissionGatekeeper(auditLog, mockLogger, mockPrompt);

    const request = {
      actor: 'software-engineer' as any,
      action: 'file-write' as const,
      params: { path: 'error-prone.json' },
    };

    const decision = await gatekeeper.authorize(request);
    expect(decision.granted).toBe(false);
    expect(decision.denialReason).toBe('error');

    // Prompt error handled without throwing
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Verify decision exists in audit log
    const recent = auditLog.recent();
    const decisions = recent.filter(r => r.event_type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].correlation_id).toBe(decision.correlationId);
    expect(decisions[0].approval_status).toBe('denied');
  });

  it('should not invoke recordOutcome during authorize call', async () => {
    const mockPrompt = vi.fn().mockResolvedValue(true);
    const gatekeeper = new PermissionGatekeeper(auditLog, logger, mockPrompt);

    const request = {
      actor: 'software-engineer' as any,
      action: 'file-write' as const,
      params: { path: 'outcome-test.json' },
    };

    const decision = await gatekeeper.authorize(request);
    expect(decision.granted).toBe(true);

    const recent = auditLog.recent();
    const decisions = recent.filter(r => r.event_type === 'decision');
    expect(decisions).toHaveLength(1); // exactly one decision row
    expect(decisions[0].event_type).toBe('decision');
  });

  describe('Role-Based Policy Enforcement', () => {
    it('should reject an agent attempting an action outside its allow-list immediately at step 1', async () => {
      const mockPrompt = vi.fn().mockResolvedValue(true);
      const gatekeeper = new PermissionGatekeeper(auditLog, logger, mockPrompt);

      // 'researcher' role only has 'file-read' in allowedActions
      const request = {
        actor: 'researcher' as any,
        action: 'file-write' as const,
        params: { path: 'unauthorized-write.txt' },
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(false);
      expect(decision.denialReason).toBe('not-permitted');
      expect(decision.approver).toBe('system');

      // Approval prompt must NOT be invoked when role check fails
      expect(mockPrompt).not.toHaveBeenCalled();

      // Audit log must record decision denial with system approver
      const recent = auditLog.recent();
      expect(recent).toHaveLength(2); // request + decision
      expect(recent[0].approval_status).toBe('denied');
      expect(recent[0].approver).toBe('system');
    });

    it('should reject an actor with no policy entry at step 1 even if prompt would approve', async () => {
      const mockPrompt = vi.fn().mockResolvedValue(true);
      const gatekeeper = new PermissionGatekeeper(auditLog, logger, mockPrompt);

      const request = {
        actor: 'unregistered-agent' as any,
        action: 'file-read' as const,
        params: { path: 'any.txt' },
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(false);
      expect(decision.denialReason).toBe('not-permitted');
      expect(mockPrompt).not.toHaveBeenCalled();
    });
  });

  describe('Policy Pre-Approval', () => {
    it('should auto-approve pre-approved actions without invoking prompt and record approver as policy', async () => {
      const mockPrompt = vi.fn().mockResolvedValue(false);
      const gatekeeper = new PermissionGatekeeper(auditLog, logger, mockPrompt);

      // 'software-engineer' has 'file-read' in autoApproveActions
      const request = {
        actor: 'software-engineer' as any,
        action: 'file-read' as const,
        params: { path: 'read-only.txt' },
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(true);
      expect(decision.approver).toBe('policy');

      // Prompt must NOT be called for auto-approved actions
      expect(mockPrompt).not.toHaveBeenCalled();

      // Audit log records decision with approver = 'policy'
      const recent = auditLog.recent();
      const decisions = recent.filter(r => r.event_type === 'decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].approval_status).toBe('granted');
      expect(decisions[0].approver).toBe('policy');
    });
  });

  describe('High-Friction Confirmation Prompt', () => {
    it('should require exact confirmation phrase for high-friction actions and reject plain "y"', async () => {
      Object.defineProperty(stdin, 'isTTY', {
        value: true,
        configurable: true,
        writable: true,
      });

      const highFrictionPrompt = createHighFrictionApprovalPrompt();
      const gatekeeper = new PermissionGatekeeper(
        auditLog,
        logger,
        denyAllPrompt,
        DEFAULT_AGENT_POLICIES,
        highFrictionPrompt
      );

      const request = {
        actor: 'software-engineer' as any,
        action: 'git-force-push' as const,
        params: { branch: 'main' },
      };

      // Scenario 1: User enters plain "y" -> should be DENIED
      mockQuestion.mockResolvedValueOnce('y');
      const decisionDeny = await gatekeeper.authorize(request);
      expect(decisionDeny.granted).toBe(false);
      expect(decisionDeny.denialReason).toBe('explicit');

      // Scenario 2: User enters exact confirmation phrase "CONFIRM FORCE PUSH" -> should be GRANTED
      mockQuestion.mockResolvedValueOnce('CONFIRM FORCE PUSH');
      const decisionGrant = await gatekeeper.authorize(request);
      expect(decisionGrant.granted).toBe(true);
      expect(decisionGrant.approver).toBe('user');
    });
  });

  describe('Terminal Allowlist Matching Semantics', () => {
    it('should match exact and wildcard allowlist entries', async () => {
      // Mock env vars for JARVIS_TERMINAL_ALLOWLIST
      process.env.JARVIS_TERMINAL_ALLOWLIST = 'echo hello,npm run *';
      clearConfigCache();

      const gatekeeper = new PermissionGatekeeper(auditLog, logger, denyAllPrompt);

      // Exact match
      const req1 = { actor: 'terminal-operator' as any, action: 'terminal-run' as const, params: { command: 'echo hello' } };
      const res1 = await gatekeeper.authorize(req1);
      expect(res1.granted).toBe(true);
      expect(res1.approver).toBe('policy'); // pre-approved

      // Wildcard match
      const req2 = { actor: 'terminal-operator' as any, action: 'terminal-run' as const, params: { command: 'npm run build' } };
      const res2 = await gatekeeper.authorize(req2);
      expect(res2.granted).toBe(true);
      expect(res2.approver).toBe('policy');

      // Wildcard mismatch (does not match prefix)
      const req3 = { actor: 'terminal-operator' as any, action: 'terminal-run' as const, params: { command: 'npm test' } };
      const res3 = await gatekeeper.authorize(req3);
      // Since it's denied by allowlist, it routes to highFrictionPrompt, which defaults to denyAllPrompt here, so denied
      expect(res3.granted).toBe(false);

      delete process.env.JARVIS_TERMINAL_ALLOWLIST;
      clearConfigCache();
    });
  });

  describe('actingOnBehalfOf type validation', () => {
    it('should correctly accept valid AgentRole as actingOnBehalfOf', async () => {
      const gatekeeper = new PermissionGatekeeper(auditLog, logger, denyAllPrompt);

      const request = {
        actor: 'software-engineer' as any,
        action: 'file-read' as const,
        params: { path: 'test.txt', actingOnBehalfOf: 'researcher' as const }, // valid AgentRole
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(true);
      
      const recent = auditLog.recent();
      expect(recent[0].params_json).toContain('"actingOnBehalfOf":"researcher"');
    });

    it('should surface type errors if an invalid string is passed to actingOnBehalfOf (Compile time enforcement)', () => {
      const request: PermissionRequest = {
        actor: 'software-engineer',
        action: 'file-read' as const,
        // @ts-expect-error - 'invalid-role' is not a valid AgentRole
        params: { path: 'test.txt', actingOnBehalfOf: 'invalid-role' },
      };
      
      expect(request.params.actingOnBehalfOf).toBe('invalid-role');
    });
  });

  describe('Readline interactive approval prompt', () => {
    let gatekeeper: PermissionGatekeeper;

    beforeEach(() => {
      // Force TTY to be true for interactive tests
      Object.defineProperty(stdin, 'isTTY', {
        value: true,
        configurable: true,
        writable: true,
      });
      // Setup gatekeeper with the real stdin approval prompt
      const prompt = createStdinApprovalPrompt();
      gatekeeper = new PermissionGatekeeper(auditLog, logger, prompt);
    });

    it('should grant permission when user responds with "y"', async () => {
      mockQuestion.mockResolvedValue('y');

      const request = {
        actor: 'software-engineer' as any,
        action: 'file-write' as const,
        params: { path: 'readline-allowed.json' },
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(true);
      expect(decision.denialReason).toBeUndefined();

      // Check audit log
      const recent = auditLog.recent();
      const decisions = recent.filter(r => r.event_type === 'decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].approval_status).toBe('granted');
      expect(decisions[0].params_json).toContain('readline-allowed.json');
    });

    it('should deny permission explicitly when user responds with anything else', async () => {
      mockQuestion.mockResolvedValue('n');

      const request = {
        actor: 'software-engineer' as any,
        action: 'file-write' as const,
        params: { path: 'readline-denied.json' },
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(false);
      expect(decision.denialReason).toBe('explicit');

      // Check audit log
      const recent = auditLog.recent();
      const decisions = recent.filter(r => r.event_type === 'decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].approval_status).toBe('denied');
    });

    it('should deny permission with timeout when user fails to respond in time', async () => {
      // Configure extremely short timeout for testing (10ms)
      process.env.JARVIS_APPROVAL_TIMEOUT_MS = '10';
      clearConfigCache();

      // Mock question to take longer (100ms)
      mockQuestion.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('y'), 100)));

      const request = {
        actor: 'software-engineer' as any,
        action: 'file-write' as const,
        params: { path: 'readline-timeout.json' },
      };

      const decision = await gatekeeper.authorize(request);
      expect(decision.granted).toBe(false);
      expect(decision.denialReason).toBe('timeout');

      // Check audit log
      const recent = auditLog.recent();
      const decisions = recent.filter(r => r.event_type === 'decision');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].approval_status).toBe('denied');
    });
  });

  describe('Runtime Policy & Autonomous Mode Tests', () => {
    it('should toggle autonomous mode and auto-approve desktop-operator and terminal-operator actions', async () => {
      const promptMock = vi.fn().mockResolvedValue(false); // prompt would deny
      const gatekeeper = new PermissionGatekeeper(auditLog, logger, promptMock);

      expect(gatekeeper.isAutonomousMode()).toBe(false);

      // In default mode, desktop-mouse is not auto-approved and will prompt (mock returns false)
      const desktopReq = {
        actor: 'desktop-operator' as const,
        action: 'desktop-mouse' as const,
        params: { x: 100, y: 200 },
      };

      const defaultDecision = await gatekeeper.authorize(desktopReq);
      expect(defaultDecision.granted).toBe(false);
      expect(promptMock).toHaveBeenCalledTimes(1);

      // Enable autonomous mode
      gatekeeper.setAutonomousMode(true);
      expect(gatekeeper.isAutonomousMode()).toBe(true);

      promptMock.mockClear();

      // Now desktop-mouse should be auto-approved via policy without calling the prompt
      const autoDecision = await gatekeeper.authorize(desktopReq);
      expect(autoDecision.granted).toBe(true);
      expect(autoDecision.approver).toBe('policy');
      expect(promptMock).not.toHaveBeenCalled();

      // Terminal run should also be auto-approved
      const terminalReq = {
        actor: 'terminal-operator' as const,
        action: 'terminal-run' as const,
        params: { command: 'node -v' },
      };
      const termDecision = await gatekeeper.authorize(terminalReq);
      expect(termDecision.granted).toBe(true);
      expect(termDecision.approver).toBe('policy');
      expect(promptMock).not.toHaveBeenCalled();

      // Disable autonomous mode
      gatekeeper.setAutonomousMode(false);
      expect(gatekeeper.isAutonomousMode()).toBe(false);

      const revertedDecision = await gatekeeper.authorize(desktopReq);
      expect(revertedDecision.granted).toBe(false);
      expect(promptMock).toHaveBeenCalledTimes(1);
    });

    it('should update agent policy dynamically at runtime using updatePolicy', async () => {
      const promptMock = vi.fn().mockResolvedValue(false);
      const gatekeeper = new PermissionGatekeeper(auditLog, logger, promptMock);

      const customReq = {
        actor: 'software-engineer' as const,
        action: 'file-delete' as const,
        params: { path: 'custom.txt' },
      };

      // Initially file-delete is not auto-approved
      const decision1 = await gatekeeper.authorize(customReq);
      expect(decision1.granted).toBe(false);
      expect(promptMock).toHaveBeenCalledTimes(1);

      // Dynamically add file-delete to autoApproveActions
      gatekeeper.updatePolicy('software-engineer', {
        autoApproveActions: ['file-read', 'memory-read', 'vision-read', 'file-delete'],
      });

      promptMock.mockClear();

      const decision2 = await gatekeeper.authorize(customReq);
      expect(decision2.granted).toBe(true);
      expect(decision2.approver).toBe('policy');
      expect(promptMock).not.toHaveBeenCalled();
    });
  });
});
