import { GeminiConnector } from '../../../connectors/gemini/GeminiConnector.js';

export type ModelProviderType = 'ollama' | 'lmstudio' | 'api_key' | 'custom_url';

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ModelListResult {
  models: ModelInfo[];
  provider: ModelProviderType;
  error?: string;
}

export interface ModelRuntimeConfig {
  provider: ModelProviderType;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  customUrl?: string;
}

/**
 * Fetches available models from Ollama by querying the local tags endpoint (/api/tags).
 *
 * @param baseUrl Base URL for Ollama (defaults to http://localhost:11434).
 * @param timeoutMs Request timeout in milliseconds (defaults to 4000ms).
 */
export async function fetchOllamaModels(
  baseUrl = 'http://localhost:11434',
  timeoutMs = 4000
): Promise<ModelListResult> {
  const cleanUrl = baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${cleanUrl}/api/tags`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        models: [],
        provider: 'ollama',
        error: `Ollama returned HTTP status ${response.status}`,
      };
    }

    const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const rawModels = data.models ?? [];
    const models: ModelInfo[] = rawModels
      .map((m) => {
        const id = m.name || m.model || '';
        return { id, name: id };
      })
      .filter((m) => Boolean(m.id));

    return {
      models,
      provider: 'ollama',
    };
  } catch (err: any) {
    return {
      models: [],
      provider: 'ollama',
      error: `Failed to connect to Ollama at ${cleanUrl}: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches available models from LM Studio by querying the local OpenAI-compatible endpoint (/v1/models).
 *
 * @param baseUrl Base URL for LM Studio (defaults to http://localhost:1234).
 * @param timeoutMs Request timeout in milliseconds (defaults to 4000ms).
 */
export async function fetchLMStudioModels(
  baseUrl = 'http://localhost:1234',
  timeoutMs = 4000
): Promise<ModelListResult> {
  const cleanUrl = baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${cleanUrl}/v1/models`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        models: [],
        provider: 'lmstudio',
        error: `LM Studio returned HTTP status ${response.status}`,
      };
    }

    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const rawModels = data.data ?? [];
    const models: ModelInfo[] = rawModels
      .map((m) => {
        const id = m.id || '';
        return { id, name: id };
      })
      .filter((m) => Boolean(m.id));

    return {
      models,
      provider: 'lmstudio',
    };
  } catch (err: any) {
    return {
      models: [],
      provider: 'lmstudio',
      error: `Failed to connect to LM Studio at ${cleanUrl}: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates an external API key against the corresponding SDK client.
 * For Gemini, validates using the Google Generative AI SDK.
 *
 * @param provider External provider ('gemini' | 'openai').
 * @param apiKey The secret API key string.
 * @param model Target model identifier (optional).
 */
export async function validateExternalApiKey(
  provider: 'gemini' | 'openai',
  apiKey: string,
  model?: string
): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, error: 'API key is required.' };
  }

  if (provider === 'gemini') {
    return GeminiConnector.validateApiKey(apiKey.trim(), model ?? 'gemini-3.6-flash');
  }

  if (provider === 'openai') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        signal: controller.signal,
      });
      if (res.ok) {
        return { valid: true };
      }
      const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
      return { valid: false, error: err?.error?.message || `Authentication failed (HTTP ${res.status})` };
    } catch (err: any) {
      return { valid: false, error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  return { valid: false, error: `Unsupported provider: ${provider}` };
}
