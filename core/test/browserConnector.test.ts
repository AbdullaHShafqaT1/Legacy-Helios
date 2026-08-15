import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../src/queue/db.js';
import { AuditLog } from '../src/permissions/auditLog.js';
import { createLogger } from '../src/lib/logger.js';
import { PermissionGatekeeper } from '../src/permissions/gatekeeper.js';
import { BrowserConnector } from '../../connectors/browser/BrowserConnector.js';
import { clearConfigCache } from '../src/lib/config.js';

describe('BrowserConnector Gating & Guttering Unit Tests', () => {
  let db: any;
  let auditLog: AuditLog;
  let logger: any;
  let gatekeeper: PermissionGatekeeper;
  let mockStandardPrompt: any;
  let mockHighFrictionPrompt: any;
  let browserConnector: BrowserConnector;

  beforeEach(() => {
    db = openDb(':memory:');
    auditLog = new AuditLog(db);
    logger = createLogger('browser-test', 'silent');

    mockStandardPrompt = vi.fn().mockResolvedValue(true);
    mockHighFrictionPrompt = vi.fn().mockResolvedValue(true);

    gatekeeper = new PermissionGatekeeper(
      auditLog,
      logger,
      mockStandardPrompt,
      undefined,
      mockHighFrictionPrompt
    );

    browserConnector = new BrowserConnector({
      gatekeeper,
      auditLog,
      logger,
      headless: true,
    });

    clearConfigCache();
  });

  afterEach(() => {
    db.close();
    clearConfigCache();
  });

  it('should auto-approve browser-read on external URLs', async () => {
    const decision = await gatekeeper.authorize({
      actor: 'browser-operator',
      action: 'browser-read',
      params: { url: 'https://example.com' },
    });
    expect(decision.granted).toBe(true);
    expect(decision.approver).toBe('policy');
  });

  it('should elevate and block local resource URLs by default', async () => {
    // localhost should map to browser-admin which is not allowed by policy
    const decision = await gatekeeper.authorize({
      actor: 'browser-operator',
      action: 'browser-read',
      params: { url: 'http://localhost:8080' },
    });
    expect(decision.granted).toBe(false);
    expect(decision.denialReason).toBe('not-permitted');
    expect(decision.approver).toBe('system');
  });

  it('should elevate and block file:// URLs by default', async () => {
    const decision = await gatekeeper.authorize({
      actor: 'browser-operator',
      action: 'browser-read',
      params: { url: 'file:///etc/passwd' },
    });
    expect(decision.granted).toBe(false);
    expect(decision.denialReason).toBe('not-permitted');
  });

  it('should allow local resources if explicitly added to browser local allowlist', async () => {
    process.env.JARVIS_BROWSER_LOCAL_ALLOWLIST = 'localhost';
    clearConfigCache();

    // Since we cleared cache, gatekeeper will load new allowlist
    const decision = await gatekeeper.authorize({
      actor: 'browser-operator',
      action: 'browser-read',
      params: { url: 'http://localhost:8080' },
    });
    expect(decision.granted).toBe(true);
    expect(decision.approver).toBe('policy');

    delete process.env.JARVIS_BROWSER_LOCAL_ALLOWLIST;
    clearConfigCache();
  });

  describe('Browser Write Gating & Operations', () => {
    let ensureBrowserStub: any;

    beforeEach(() => {
      const fakePage = {
        goto: vi.fn().mockResolvedValue(undefined),
        innerText: vi.fn().mockResolvedValue('hello'),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        setInputFiles: vi.fn().mockResolvedValue(undefined),
        waitForEvent: vi.fn().mockResolvedValue({
          path: vi.fn().mockResolvedValue('/tmp/downloaded-file.txt'),
        }),
      };
      ensureBrowserStub = vi
        .spyOn(browserConnector as any, 'ensureBrowser')
        .mockResolvedValue(fakePage as any);
    });

    afterEach(() => {
      ensureBrowserStub.mockRestore();
    });

    const getLatestDecision = (action: string) => {
      const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 5').all();
      return rows.find((r: any) => r.event_type === 'decision' && r.action === action);
    };

    it('should route browser-write action click to standard user prompt', async () => {
      mockStandardPrompt.mockResolvedValue(true);
      await browserConnector.click('browser-operator', '#submit-btn');
      
      expect(mockStandardPrompt).toHaveBeenCalled();
      const lastCall = mockStandardPrompt.mock.calls[0][0];
      expect(lastCall.action).toBe('browser-write');
      expect(lastCall.params.action).toBe('click');
      expect(lastCall.params.selector).toBe('#submit-btn');

      const decision = getLatestDecision('browser-write');
      expect(decision).toBeDefined();
      expect(decision?.approver).toBe('user');
    });

    it('should route browser-write action fill to standard user prompt', async () => {
      mockStandardPrompt.mockResolvedValue(true);
      await browserConnector.fill('browser-operator', '#input-field', 'some-value');
      
      expect(mockStandardPrompt).toHaveBeenCalled();
      const decision = getLatestDecision('browser-write');
      expect(decision?.approver).toBe('user');
    });

    it('should route browser-write action download to standard user prompt', async () => {
      mockStandardPrompt.mockResolvedValue(true);
      const downloadPath = await browserConnector.download('browser-operator', 'https://example.com/file.zip');
      expect(downloadPath).toBe('/tmp/downloaded-file.txt');
      
      expect(mockStandardPrompt).toHaveBeenCalled();
      const decision = getLatestDecision('browser-write');
      expect(decision?.approver).toBe('user');
    });

    it('should route browser-write action upload to standard user prompt', async () => {
      mockStandardPrompt.mockResolvedValue(true);
      await browserConnector.upload('browser-operator', '#upload-input', '/path/to/file.txt');
      
      expect(mockStandardPrompt).toHaveBeenCalled();
      const decision = getLatestDecision('browser-write');
      expect(decision?.approver).toBe('user');
    });
  });
});
