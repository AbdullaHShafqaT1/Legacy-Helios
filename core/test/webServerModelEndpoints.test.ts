import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';

describe('Web Server Model Endpoints Integration Tests', () => {
  let webProcess: ChildProcess | null = null;
  const port = 3099;

  beforeAll(async () => {
    const serverPath = path.resolve(process.cwd(), 'apps/web/server.ts');
    webProcess = spawn('npx', ['tsx', serverPath], {
      env: {
        ...process.env,
        JARVIS_WEB_PORT: String(port),
        JARVIS_DASHBOARD_PORT: '8095',
      },
      stdio: 'pipe',
      shell: true,
    });

    // Wait for web server to be listening
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Web server start timeout')), 10000);
      const interval = setInterval(() => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/api/models/active', method: 'GET' }, (res) => {
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
  }, 15000);

  afterAll(() => {
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

  function makeRequest(method: string, path: string, body?: object): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {},
        },
        (res) => {
          let chunks = '';
          res.on('data', (c) => { chunks += c; });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode || 500, data: JSON.parse(chunks) });
            } catch {
              resolve({ status: res.statusCode || 500, data: chunks });
            }
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('GET /api/models/active returns active model provider', async () => {
    const res = await makeRequest('GET', '/api/models/active');
    expect(res.status).toBe(200);
    expect(res.data.provider).toBeDefined();
  });

  it('POST /api/models/set-provider dynamically switches active provider', async () => {
    const res = await makeRequest('POST', '/api/models/set-provider', {
      provider: 'custom_url',
      model: 'test-custom',
      customUrl: 'http://localhost:9000/v1',
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.provider).toBe('custom_url');

    const verifyRes = await makeRequest('GET', '/api/models/active');
    expect(verifyRes.data.provider).toBe('custom_url');
    expect(verifyRes.data.customUrl).toBe('http://localhost:9000/v1');
  });

  it('GET /api/models/ollama returns structured list or offline error without crashing', async () => {
    const res = await makeRequest('GET', '/api/models/ollama');
    expect(res.status).toBe(200);
    expect(res.data.provider).toBe('ollama');
    expect(Array.isArray(res.data.models)).toBe(true);
  });

  it('GET /api/models/lmstudio returns structured list or offline error without crashing', async () => {
    const res = await makeRequest('GET', '/api/models/lmstudio');
    expect(res.status).toBe(200);
    expect(res.data.provider).toBe('lmstudio');
    expect(Array.isArray(res.data.models)).toBe(true);
  });
});
