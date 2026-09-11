import { Logger } from 'pino';
import { ModelRoute, ModelRequestContext, ModelResponse, TaskType } from '../../core/src/router/modelRouter.js';

export class CustomUrlConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomUrlConnectorError';
    Object.setPrototypeOf(this, CustomUrlConnectorError.prototype);
  }
}

export interface CustomUrlConnectorOptions {
  endpointUrl?: string;
  model?: string;
  logger?: Logger;
  timeoutMs?: number;
}

export class CustomUrlConnector implements ModelRoute {
  taskTypes: TaskType[] = ['coding', 'reasoning', 'vision'];

  private endpointUrl: string;
  private model: string;
  private logger?: Logger;
  private timeoutMs: number;

  constructor(options: CustomUrlConnectorOptions = {}) {
    this.endpointUrl = (options.endpointUrl ?? 'http://localhost:8000/v1').replace(/\/+$/, '');
    this.model = options.model ?? 'custom-model';
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 60000;
  }

  setEndpointUrl(url: string): void {
    if (url && url.trim()) {
      this.endpointUrl = url.trim().replace(/\/+$/, '');
    }
  }

  getEndpointUrl(): string {
    return this.endpointUrl;
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
   * Invokes the custom endpoint using OpenAI-compatible chat completion format.
   * If the custom backend is a placeholder, provides a structured response.
   */
  async invoke(context: ModelRequestContext): Promise<ModelResponse> {
    const textPrompt = context.description;
    const body = JSON.stringify({
      model: this.model,
      messages: [{ role: 'user', content: textPrompt }],
      stream: false,
    });

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const targetUrl = this.endpointUrl.endsWith('/chat/completions')
        ? this.endpointUrl
        : `${this.endpointUrl}/chat/completions`;

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        throw new CustomUrlConnectorError(`Custom endpoint returned HTTP ${response.status}`);
      }

      const json = (await response.json()) as any;
      const text = json.choices?.[0]?.message?.content ?? json.text ?? JSON.stringify(json);
      return { text, raw: json };
    } catch (err: any) {
      this.logger?.warn({ err: err.message, endpoint: this.endpointUrl }, 'Custom URL endpoint invocation failed');
      throw new CustomUrlConnectorError(`Custom URL endpoint (${this.endpointUrl}) error: ${err.message}`);
    }
  }
}
