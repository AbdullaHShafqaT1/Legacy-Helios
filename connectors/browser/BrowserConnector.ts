import { chromium, Browser, Page } from 'playwright';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { Logger } from 'pino';
import { redactSecrets } from '../../core/src/lib/redact.js';
import { AgentRole } from '../../core/src/permissions/policy.js';
import { executionContext } from '../../core/src/lib/context.js';

export interface BrowserConnectorOptions {
  gatekeeper: PermissionGatekeeper;
  auditLog: AuditLog;
  logger: Logger;
  headless?: boolean;
}

export class BrowserConnector {
  private gatekeeper: PermissionGatekeeper;
  private auditLog: AuditLog;
  private logger: Logger;
  private headless: boolean;
  private sessions = new Map<string, { browser: Browser; page: Page }>();

  constructor(options: BrowserConnectorOptions) {
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.logger = options.logger;
    this.headless = options.headless !== false;
  }

  private async ensureBrowser(): Promise<Page> {
    const context = executionContext.getStore();
    const taskId = context?.taskId || 'global';

    let session = this.sessions.get(taskId);
    if (session) {
      return session.page;
    }

    const browser = await chromium.launch({ headless: this.headless });
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    
    this.sessions.set(taskId, { browser, page });
    return page;
  }

  async close(taskId?: string): Promise<void> {
    if (taskId) {
      const session = this.sessions.get(taskId);
      if (session) {
        await session.browser.close();
        this.sessions.delete(taskId);
      }
    } else {
      for (const [key, session] of this.sessions.entries()) {
        await session.browser.close();
      }
      this.sessions.clear();
    }
  }

  async navigate(actor: AgentRole, url: string, actingOnBehalfOf?: AgentRole): Promise<void> {
    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'browser-read',
      params: { url, actingOnBehalfOf },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-read', 'denied — not-permitted');
      throw new Error(`Browser navigation denied: permission not granted.`);
    }

    try {
      const page = await this.ensureBrowser();
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-read', `success — navigated to ${url}`);
    } catch (err: any) {
      const errMsg = redactSecrets(err.message || String(err)) as string;
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-read', `error — ${errMsg}`);
      throw new Error(`Navigation failed: ${errMsg}`);
    }
  }

  async readContent(actor: AgentRole, actingOnBehalfOf?: AgentRole): Promise<string> {
    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'browser-read',
      params: { action: 'readContent', actingOnBehalfOf },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-read', 'denied — not-permitted');
      throw new Error(`Browser read denied: permission not granted.`);
    }

    try {
      const page = await this.ensureBrowser();
      const content = await page.innerText('body');
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-read', 'success — content read');
      return content;
    } catch (err: any) {
      const errMsg = redactSecrets(err.message || String(err)) as string;
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-read', `error — ${errMsg}`);
      throw new Error(`Read content failed: ${errMsg}`);
    }
  }

  async click(actor: AgentRole, selector: string, actingOnBehalfOf?: AgentRole): Promise<void> {
    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'browser-write',
      params: { action: 'click', selector, actingOnBehalfOf },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', 'denied — not-permitted');
      throw new Error(`Browser click denied: permission not granted.`);
    }

    try {
      const page = await this.ensureBrowser();
      await page.click(selector, { timeout: 10000 });
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', `success — clicked ${selector}`);
    } catch (err: any) {
      const errMsg = redactSecrets(err.message || String(err)) as string;
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', `error — ${errMsg}`);
      throw new Error(`Click failed: ${errMsg}`);
    }
  }

  async fill(actor: AgentRole, selector: string, value: string, actingOnBehalfOf?: AgentRole): Promise<void> {
    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'browser-write',
      params: { action: 'fill', selector, actingOnBehalfOf },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', 'denied — not-permitted');
      throw new Error(`Browser fill denied: permission not granted.`);
    }

    try {
      const page = await this.ensureBrowser();
      await page.fill(selector, value, { timeout: 10000 });
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', `success — filled ${selector}`);
    } catch (err: any) {
      const errMsg = redactSecrets(err.message || String(err)) as string;
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', `error — ${errMsg}`);
      throw new Error(`Fill failed: ${errMsg}`);
    }
  }

  async download(actor: AgentRole, url?: string, actingOnBehalfOf?: AgentRole): Promise<string> {
    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'browser-write',
      params: { action: 'download', url, actingOnBehalfOf },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', 'denied — not-permitted');
      throw new Error(`Browser download denied: permission not granted.`);
    }

    try {
      const page = await this.ensureBrowser();
      if (url) {
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      }
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
      const download = await downloadPromise;
      const path = await download.path();
      if (!path) {
        throw new Error('Download path is null');
      }
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', `success — downloaded to ${path}`);
      return path;
    } catch (err: any) {
      const errMsg = redactSecrets(err.message || String(err)) as string;
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', `error — ${errMsg}`);
      throw new Error(`Download failed: ${errMsg}`);
    }
  }

  async upload(actor: AgentRole, selector: string, filePath: string, actingOnBehalfOf?: AgentRole): Promise<void> {
    const authorization = await this.gatekeeper.authorize({
      actor,
      action: 'browser-write',
      params: { action: 'upload', selector, filePath, actingOnBehalfOf },
    });

    if (!authorization.granted) {
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', 'denied — not-permitted');
      throw new Error(`Browser upload denied: permission not granted.`);
    }

    try {
      const page = await this.ensureBrowser();
      await page.setInputFiles(selector, filePath, { timeout: 10000 });
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', `success — uploaded ${filePath} to ${selector}`);
    } catch (err: any) {
      const errMsg = redactSecrets(err.message || String(err)) as string;
      this.auditLog.recordOutcome(authorization.correlationId, actor, 'browser-write', `error — ${errMsg}`);
      throw new Error(`Upload failed: ${errMsg}`);
    }
  }
}
