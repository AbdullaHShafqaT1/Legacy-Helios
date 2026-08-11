import { chromium, Browser, Page } from 'playwright';
import { PermissionGatekeeper } from '../../core/src/permissions/gatekeeper.js';
import { AuditLog } from '../../core/src/permissions/auditLog.js';
import { Logger } from 'pino';
import { redactSecrets } from '../../core/src/lib/redact.js';

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
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(options: BrowserConnectorOptions) {
    this.gatekeeper = options.gatekeeper;
    this.auditLog = options.auditLog;
    this.logger = options.logger;
    this.headless = options.headless !== false;
  }

  private async ensureBrowser(): Promise<Page> {
    if (this.browser && this.page) {
      return this.page;
    }
    this.browser = await chromium.launch({ headless: this.headless });
    const context = await this.browser.newContext();
    this.page = await context.newPage();
    return this.page;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  async navigate(actor: string, url: string, actingOnBehalfOf?: string): Promise<void> {
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

  async readContent(actor: string, actingOnBehalfOf?: string): Promise<string> {
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

  async click(actor: string, selector: string, actingOnBehalfOf?: string): Promise<void> {
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

  async fill(actor: string, selector: string, value: string, actingOnBehalfOf?: string): Promise<void> {
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

  async download(actor: string, url?: string, actingOnBehalfOf?: string): Promise<string> {
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

  async upload(actor: string, selector: string, filePath: string, actingOnBehalfOf?: string): Promise<void> {
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
