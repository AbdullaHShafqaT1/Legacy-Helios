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
    this.model = options.model ?? 'gemini-1.5-flash';
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
      this.model = model.trim();
    }
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Validates an API key against the Google Generative AI client.
   * Performs a lightweight token count or check to confirm authorization.
   */
  static async validateApiKey(apiKey: string, model = 'gemini-1.5-flash'): Promise<{ valid: boolean; error?: string }> {
    if (!apiKey || !apiKey.trim()) {
      return { valid: false, error: 'API key cannot be empty.' };
    }

    try {
      const client = new GoogleGenerativeAI(apiKey.trim());
      const genModel = client.getGenerativeModel({ model });
      // Lightweight call to test credentials
      await genModel.countTokens('validation test');
      return { valid: true };
    } catch (err: any) {
      const message = err?.message || 'Invalid API key or network error.';
      return { valid: false, error: message };
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
