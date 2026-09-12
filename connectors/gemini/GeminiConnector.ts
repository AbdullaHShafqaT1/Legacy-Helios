import { GoogleGenerativeAI } from '@google/generative-ai';
import { Logger } from 'pino';
import { ModelRoute, ModelRequestContext, ModelResponse, TaskType } from '../../core/src/router/modelRouter.js';
import { redactSecrets } from '../../core/src/lib/redact.js';

export class GeminiConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiConnectorError';
    Object.setPrototypeOf(this, GeminiConnectorError.prototype);
  }
}

export interface GeminiConnectorOptions {
  apiKey: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
  logger?: Logger;
}

export class GeminiConnector implements ModelRoute {
  taskTypes: TaskType[] = ['coding', 'reasoning', 'vision'];

  private apiKey: string;
  private model: string;
  private maxRetries: number;
  private timeoutMs: number;
  private logger?: Logger;
  private client: GoogleGenerativeAI;

  constructor(options: GeminiConnectorOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new GeminiConnectorError('API key must be provided.');
    }
    this.apiKey = options.apiKey.trim();
    const initialModel = options.model ?? 'gemini-3.6-flash';
    this.model = (initialModel === 'gemini-1.5-flash' || initialModel === 'gemini-2.5-flash') ? 'gemini-3.6-flash' : initialModel;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.logger = options.logger;
    this.client = new GoogleGenerativeAI(this.apiKey);
  }

  setApiKey(apiKey: string): void {
    if (!apiKey || !apiKey.trim()) {
      throw new GeminiConnectorError('API key cannot be empty.');
    }
    this.apiKey = apiKey.trim();
    this.client = new GoogleGenerativeAI(this.apiKey);
  }

  setModel(model: string): void {
    if (model && model.trim()) {
      const trimmed = model.trim();
      this.model = (trimmed === 'gemini-1.5-flash' || trimmed === 'gemini-2.5-flash') ? 'gemini-3.6-flash' : trimmed;
    }
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Validates an API key against Google's Generative Language API.
   * Directly queries the models list endpoint to confirm key validity independent of specific model tags.
   */
  static async validateApiKey(apiKey: string, model = 'gemini-3.6-flash'): Promise<{ valid: boolean; error?: string }> {
    if (!apiKey || !apiKey.trim()) {
      return { valid: false, error: 'API key cannot be empty.' };
    }

    const key = apiKey.trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      // 1. Direct models list check via Google Generative Language REST API
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        return { valid: true };
      }

      const errData = (await res.json().catch(() => null)) as any;
      const message = errData?.error?.message || `Validation failed with status ${res.status}`;
      return { valid: false, error: message };
    } catch (netErr: any) {
      clearTimeout(timer);
      // 2. Fallback to SDK getGenerativeModel token count if fetch was aborted/failed
      try {
        const normalizedModel = (model === 'gemini-1.5-flash' || model === 'gemini-2.5-flash') ? 'gemini-3.6-flash' : model;
        const client = new GoogleGenerativeAI(key);
        const genModel = client.getGenerativeModel({ model: normalizedModel });
        await genModel.countTokens('validation test');
        return { valid: true };
      } catch (sdkErr: any) {
        const message = sdkErr?.message || netErr?.message || 'Invalid API key or network error.';
        return { valid: false, error: message };
      }
    }
  }

  /**
   * Invokes the Gemini model using the Google Generative AI SDK.
   * Supports text prompt, fileContext, and multimodal vision inputs.
   */
  async invoke(context: ModelRequestContext): Promise<ModelResponse> {
    let prompt = context.description;
    if (context.fileContext !== undefined && context.fileContext !== null) {
      prompt += `\n\nFile Context:\n${JSON.stringify(context.fileContext, null, 2)}`;
    }

    let attempt = 0;
    const maxRetries = this.maxRetries;

    while (true) {
      try {
        attempt++;

        const genModel = this.client.getGenerativeModel({ model: this.model });

        const contents: any[] = [];
        if (context.image) {
          contents.push({
            inlineData: {
              data: context.image.base64,
              mimeType: context.image.mediaType,
            },
          });
        }
        contents.push(prompt);

        // Execute request with timeout guard
        const generatePromise = genModel.generateContent(contents);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Gemini request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        });

        const result = await Promise.race([generatePromise, timeoutPromise]);
        const response = result.response;
        const text = response.text();

        return {
          text,
          raw: response,
        };
      } catch (err: any) {
        const isLastAttempt = attempt >= maxRetries;
        if (isLastAttempt) {
          this.logger?.error(
            { err: redactSecrets(err), attempt, maxRetries },
            'Gemini invocation failed after max retries.'
          );
          if (err instanceof GeminiConnectorError) {
            throw err;
          }
          throw new GeminiConnectorError(`Gemini request failed: ${err.message}`);
        }

        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        this.logger?.warn(
          { attempt, backoffMs, err: err.message },
          'Gemini invocation attempt failed, retrying...'
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
}
