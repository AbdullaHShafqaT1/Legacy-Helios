import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchOllamaModels,
  fetchLMStudioModels,
  validateExternalApiKey,
} from '../src/router/modelProviderService.js';
import { ModelRouter } from '../src/router/modelRouter.js';
import { OllamaConnector } from '../../connectors/ollama/OllamaConnector.js';
import { LMStudioConnector } from '../../connectors/lmstudio/LMStudioConnector.js';
import { GeminiConnector } from '../../connectors/gemini/GeminiConnector.js';
import { CustomUrlConnector } from '../../connectors/custom/CustomUrlConnector.js';
import pino from 'pino';

const testLogger = pino({ level: 'silent' });

describe('modelProviderService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('fetchOllamaModels', () => {
    it('successfully parses Ollama /api/tags response', async () => {
      const mockTags = {
        models: [
          { name: 'llava:latest', model: 'llava:latest', size: 4733363377 },
          { name: 'llama3:8b', model: 'llama3:8b', size: 4733363377 },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockTags,
      } as any);

      const result = await fetchOllamaModels('http://localhost:11434');

      expect(result.provider).toBe('ollama');
      expect(result.error).toBeUndefined();
      expect(result.models).toEqual([
        { id: 'llava:latest', name: 'llava:latest' },
        { id: 'llama3:8b', name: 'llama3:8b' },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns error info gracefully when Ollama is unreachable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await fetchOllamaModels('http://localhost:11434');

      expect(result.provider).toBe('ollama');
      expect(result.models).toEqual([]);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('handles non-200 HTTP responses from Ollama', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      } as any);

      const result = await fetchOllamaModels('http://localhost:11434');
      expect(result.models).toEqual([]);
      expect(result.error).toContain('503');
    });
  });

  describe('fetchLMStudioModels', () => {
    it('successfully parses LM Studio OpenAI-compatible /v1/models response', async () => {
      const mockModels = {
        data: [
          { id: 'meta-llama-3-8b-instruct', object: 'model' },
          { id: 'mistral-7b-instruct', object: 'model' },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockModels,
      } as any);

      const result = await fetchLMStudioModels('http://localhost:1234');

      expect(result.provider).toBe('lmstudio');
      expect(result.error).toBeUndefined();
      expect(result.models).toEqual([
        { id: 'meta-llama-3-8b-instruct', name: 'meta-llama-3-8b-instruct' },
        { id: 'mistral-7b-instruct', name: 'mistral-7b-instruct' },
      ]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/models',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns error info gracefully when LM Studio is unreachable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await fetchLMStudioModels('http://localhost:1234');

      expect(result.provider).toBe('lmstudio');
      expect(result.models).toEqual([]);
      expect(result.error).toContain('ECONNREFUSED');
    });
  });

  describe('validateExternalApiKey', () => {
    it('returns valid: false when API key is empty', async () => {
      const result = await validateExternalApiKey('gemini', '   ');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('validates Gemini API key successfully using GeminiConnector mock', async () => {
      vi.spyOn(GeminiConnector, 'validateApiKey').mockResolvedValue({ valid: true });

      const result = await validateExternalApiKey('gemini', 'valid-test-key-123');
      expect(result.valid).toBe(true);
      expect(GeminiConnector.validateApiKey).toHaveBeenCalledWith('valid-test-key-123', 'gemini-1.5-flash');
    });

    it('handles Gemini API key rejection gracefully', async () => {
      vi.spyOn(GeminiConnector, 'validateApiKey').mockResolvedValue({
        valid: false,
        error: 'API_KEY_INVALID: The key provided is invalid.',
      });

      const result = await validateExternalApiKey('gemini', 'bad-key');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('API_KEY_INVALID');
    });
  });

  describe('Connectors and ModelRouter integration', () => {
    it('LMStudioConnector properly executes chat completions', async () => {
      const connector = new LMStudioConnector({
        model: 'test-model',
        baseUrl: 'http://localhost:1234',
        logger: testLogger,
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Hello from LM Studio!' } }],
        }),
      } as any);

      const response = await connector.invoke({ description: 'Hi there' });
      expect(response.text).toBe('Hello from LM Studio!');
    });

    it('CustomUrlConnector invokes custom endpoint correctly', async () => {
      const connector = new CustomUrlConnector({
        endpointUrl: 'http://localhost:8000/v1',
        model: 'my-custom-model',
        logger: testLogger,
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Custom response' } }],
        }),
      } as any);

      const response = await connector.invoke({ description: 'Testing custom' });
      expect(response.text).toBe('Custom response');
    });

    it('ModelRouter dynamically routes to active provider', async () => {
      const router = new ModelRouter();

      const ollama = new OllamaConnector({ logger: testLogger });
      const lmstudio = new LMStudioConnector({ logger: testLogger });
      const custom = new CustomUrlConnector({ logger: testLogger });

      vi.spyOn(ollama, 'invoke').mockResolvedValue({ text: 'Ollama answer' });
      vi.spyOn(lmstudio, 'invoke').mockResolvedValue({ text: 'LM Studio answer' });
      vi.spyOn(custom, 'invoke').mockResolvedValue({ text: 'Custom answer' });

      router.register(ollama);
      router.register(lmstudio);
      router.register(custom);

      // Default active is ollama
      expect(router.getActiveProvider()).toBe('ollama');
      let res = await router.route('reasoning', { description: 'test' });
      expect(res.text).toBe('Ollama answer');

      // Switch to lmstudio
      router.setActiveProvider('lmstudio');
      expect(router.getActiveProvider()).toBe('lmstudio');
      res = await router.route('reasoning', { description: 'test' });
      expect(res.text).toBe('LM Studio answer');

      // Switch to custom_url
      router.setActiveProvider('custom_url');
      res = await router.route('reasoning', { description: 'test' });
      expect(res.text).toBe('Custom answer');

      // Explicit provider in context overrides activeProvider
      res = await router.route('reasoning', { description: 'test', provider: 'ollama' });
      expect(res.text).toBe('Ollama answer');
    });
  });
});
