import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, Browser, Page } from 'playwright';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';

describe('Model Selection UI End-to-End Tests', () => {
  let webProcess: ChildProcess | null = null;
  let browser: Browser;
  let page: Page;
  const port = 3088;

  beforeAll(async () => {
    const serverPath = path.resolve(process.cwd(), 'apps/web/server.ts');
    webProcess = spawn('npx', ['tsx', serverPath], {
      env: {
        ...process.env,
        JARVIS_WEB_PORT: String(port),
        JARVIS_DASHBOARD_PORT: '8094',
      },
      stdio: 'pipe',
      shell: true,
    });

    // Wait for web server
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Web server failed to start')), 12000);
      const interval = setInterval(() => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/index.html', method: 'GET' }, (res) => {
          if (res.statusCode === 200) {
            clearTimeout(timeout);
            clearInterval(interval);
            resolve();
          }
        });
        req.on('error', () => {});
        req.end();
      }, 300);
    });

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`http://localhost:${port}`);
  }, 20000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (webProcess && webProcess.pid) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(webProcess.pid), '/f', '/t']);
        } else {
          webProcess.kill('SIGTERM');
        }
      } catch {}
    }
  });

  it('renders primary provider dropdown with all 4 required options', async () => {
    const select = page.locator('#provider-select');
    expect(await select.isVisible()).toBe(true);

    const options = await select.locator('option').allTextContents();
    expect(options).toContain('Ollama');
    expect(options).toContain('LM Studio');
    expect(options).toContain('API Key');
    expect(options).toContain('Custom URL');
  });

  it('renders secondary Ollama controls when Ollama is selected', async () => {
    await page.selectOption('#provider-select', 'ollama');

    expect(await page.locator('#secondary-ollama').isVisible()).toBe(true);
    expect(await page.locator('#secondary-lmstudio').isHidden()).toBe(true);
    expect(await page.locator('#secondary-api-key').isHidden()).toBe(true);
    expect(await page.locator('#secondary-custom-url').isHidden()).toBe(true);

    // Check secondary dropdown
    expect(await page.locator('#ollama-model-select').isVisible()).toBe(true);
    expect(await page.locator('#refresh-ollama-btn').isVisible()).toBe(true);
  });

  it('renders secondary LM Studio controls when LM Studio is selected', async () => {
    await page.selectOption('#provider-select', 'lmstudio');

    expect(await page.locator('#secondary-lmstudio').isVisible()).toBe(true);
    expect(await page.locator('#secondary-ollama').isHidden()).toBe(true);
    expect(await page.locator('#secondary-api-key').isHidden()).toBe(true);
    expect(await page.locator('#secondary-custom-url').isHidden()).toBe(true);

    expect(await page.locator('#lmstudio-model-select').isVisible()).toBe(true);
    expect(await page.locator('#refresh-lmstudio-btn').isVisible()).toBe(true);
  });

  it('renders password input with show/hide toggle when API Key is selected', async () => {
    await page.selectOption('#provider-select', 'api_key');

    expect(await page.locator('#secondary-api-key').isVisible()).toBe(true);
    expect(await page.locator('#secondary-ollama').isHidden()).toBe(true);
    expect(await page.locator('#secondary-lmstudio').isHidden()).toBe(true);
    expect(await page.locator('#secondary-custom-url').isHidden()).toBe(true);

    const keyInput = page.locator('#api-key-input');
    expect(await keyInput.isVisible()).toBe(true);
    expect(await keyInput.getAttribute('type')).toBe('password');

    const toggleBtn = page.locator('#toggle-key-visibility');
    expect(await toggleBtn.isVisible()).toBe(true);
    expect(await toggleBtn.textContent()).toBe('SHOW');

    // Click to show password
    await toggleBtn.click();
    expect(await keyInput.getAttribute('type')).toBe('text');
    expect(await toggleBtn.textContent()).toBe('HIDE');

    // Click again to hide password
    await toggleBtn.click();
    expect(await keyInput.getAttribute('type')).toBe('password');
    expect(await toggleBtn.textContent()).toBe('SHOW');
  });

  it('renders custom endpoint input when Custom URL is selected', async () => {
    await page.selectOption('#provider-select', 'custom_url');

    expect(await page.locator('#secondary-custom-url').isVisible()).toBe(true);
    expect(await page.locator('#secondary-ollama').isHidden()).toBe(true);
    expect(await page.locator('#secondary-lmstudio').isHidden()).toBe(true);
    expect(await page.locator('#secondary-api-key').isHidden()).toBe(true);

    const customInput = page.locator('#custom-url-input');
    expect(await customInput.isVisible()).toBe(true);
    await customInput.fill('http://localhost:9999/v1');
    await page.locator('#apply-custom-url-btn').click();

    // Verify active badge reflects custom URL
    const modelText = await page.locator('#model-name').textContent();
    expect(modelText).toContain('9999');
  });

  it('persists selected provider across page reloads', async () => {
    // Select LM Studio
    await page.selectOption('#provider-select', 'lmstudio');
    expect(await page.locator('#secondary-lmstudio').isVisible()).toBe(true);

    // Reload page
    await page.reload();

    // Should still have LM Studio selected and visible
    const select = page.locator('#provider-select');
    expect(await select.inputValue()).toBe('lmstudio');
    expect(await page.locator('#secondary-lmstudio').isVisible()).toBe(true);
    expect(await page.locator('#secondary-ollama').isHidden()).toBe(true);
  });
});
