import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import { DashboardServer } from '../src/dashboard/DashboardServer.js';
import { HealthMonitor } from '../src/lib/health.js';
import { createLogger } from '../src/lib/logger.js';
import { ModelRouter } from '../src/router/modelRouter.js';
import { GeminiConnector } from '../../connectors/gemini/GeminiConnector.js';

describe('Model Provider Endpoints Integration Tests', () => {
  let db: Database.Database;
  let server: DashboardServer;
  let modelRouter: ModelRouter;
  let healthMonitor: HealthMonitor;
  const logger = createLogger('test', 'silent');
  const port = 8097; // Custom test port

  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    db = new Database(':memory:');
    healthMonitor = new HealthMonitor(logger);
    modelRouter = new ModelRouter();

    server = new DashboardServer({
      config: {
        dashboardPort: port,
        dbPath: ':memory:',
        model: 'llava:latest',
        maxRetries: 2,
        pollIntervalMs: 1000,
        staleTaskTimeoutMs: 10000,
        logLevel: 'silent',
        approvalTimeoutMs: 1000,
        projectRoot: process.cwd(),
        vectorStorePath: '',
        vectorStoreType: '',
        embeddingDimensions: 384,
        memoryMaxEntries: 100,
        browserHeadless: true,
        browserLocalAllowlist: [],
        terminalAllowlist: [],
        terminalTimeoutMs: 1000,
        claudeTimeoutMs: 1000,
        unattended: false,
        voiceWakeWordThreshold: 0.1,
        voiceSttConfidenceThreshold: 0.8,
        voiceTtsRate: 175,
        voiceWakeWordModelPath: '',
        voiceSttModelPath: '',
        voiceAudioInputDevice: '',
        voiceAudioOutputDevice: '',
        voiceAudioSampleRate: 16000,
        voiceCiFallback: false,
        visionEnabled: false,
        visionPreferredDisplay: 0,
        visionCaptureTimeoutMs: 1000,
        visionProvider: 'claude',
        visionOcrEnabled: false,
        healthCheckIntervalMs: 1000,
        restartLimits: 3,
        restartBackoffMs: 1000,
        desktopControlEnabled: false,
        desktopActionTimeoutMs: 1000,
        desktopObservationMaxAgeMs: 1000,
        desktopMaxTextLength: 100,
        desktopMaxActionsPerSequence: 5,
        desktopRequireConfirmation: false,
        voiceWakeWordEngine: 'openwakeword',
        visionPeriodicIntervalMs: 1000,
        visionPeriodicRetentionMax: 5,
        searchProvider: 'duckduckgo',
        searchRateLimitCount: 10,
        searchRateLimitWindowMs: 60000,
        voiceDuplexPort: 8096,
        voiceDuplexInterruptThreshold: 0.02,
        voiceDuplexModelType: 'local',
        ollamaBaseUrl: 'http://localhost:11434',
        lmstudioBaseUrl: 'http://localhost:1234',
      },
      logger,
      db,
      healthMonitor,
      modelRouter,
    });

    server.start();
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await server.stop();
    db.close();
  });

  function makeRequest(
    method: string,
    path: string,
    body?: object
  ): Promise<{ status: number; data: any }> {
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
          res.on('data', (c) => {
            chunks += c;
          });
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

  it('GET /api/models/ollama returns model list from Ollama tags', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [{ name: 'llava:latest' }, { name: 'qwen2.5:latest' }],
      }),
    } as any);

    const res = await makeRequest('GET', '/api/models/ollama');
    expect(res.status).toBe(200);
    expect(res.data.provider).toBe('ollama');
    expect(res.data.models).toEqual([
      { id: 'llava:latest', name: 'llava:latest' },
      { id: 'qwen2.5:latest', name: 'qwen2.5:latest' },
    ]);
  });

  it('GET /api/models/lmstudio returns model list from LM Studio endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF' }],
      }),
    } as any);

    const res = await makeRequest('GET', '/api/models/lmstudio');
    expect(res.status).toBe(200);
    expect(res.data.provider).toBe('lmstudio');
    expect(res.data.models).toEqual([
      {
        id: 'lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF',
        name: 'lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF',
      },
    ]);
  });

  it('GET /api/models/active returns current active configuration', async () => {
    const res = await makeRequest('GET', '/api/models/active');
    expect(res.status).toBe(200);
    expect(res.data.provider).toBeDefined();
  });

  it('POST /api/models/validate-key validates an API key securely', async () => {
    vi.spyOn(GeminiConnector, 'validateApiKey').mockResolvedValue({ valid: true });

    const res = await makeRequest('POST', '/api/models/validate-key', {
      provider: 'gemini',
      apiKey: 'test-ai-key-12345',
    });

    expect(res.status).toBe(200);
    expect(res.data.valid).toBe(true);
  });

  it('POST /api/models/validate-key rejects empty API key', async () => {
    const res = await makeRequest('POST', '/api/models/validate-key', {
      provider: 'gemini',
      apiKey: '',
    });

    expect(res.status).toBe(400);
    expect(res.data.valid).toBe(false);
  });

  it('POST /api/models/set-provider updates runtime config and ModelRouter', async () => {
    const res = await makeRequest('POST', '/api/models/set-provider', {
      provider: 'lmstudio',
      model: 'mistral-7b',
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.activeProvider).toBe('lmstudio');
    expect(res.data.activeModel).toBe('mistral-7b');

    // Confirm modelRouter active provider changed
    expect(modelRouter.getActiveProvider()).toBe('lmstudio');
  });
});
