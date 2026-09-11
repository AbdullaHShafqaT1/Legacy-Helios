import { Logger } from 'pino';
import { ModelRoute, ModelRequestContext, ModelResponse, TaskType } from '../../core/src/router/modelRouter.js';
import { redactSecrets } from '../../core/src/lib/redact.js';

export class LMStudioConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LMStudioConnectorError';
    Object.setPrototypeOf(this, LMStudioConnectorError.prototype);
  }
}

export interface LMStudioConnectorOptions {
  model?: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  logger?: Logger;
}

export class LMStudioConnector implements ModelRoute {
  taskTypes: TaskType[] = ['coding', 'reasoning', 'vision'];

  private model: string;
  private baseUrl: string;
  private maxRetries: number;
  private timeoutMs: number;
  private logger?: Logger;

  constructor(options: LMStudioConnectorOptions = {}) {
    this.model = options.model ?? 'local-model';
    this.baseUrl = (options.baseUrl ?? 'http://localhost:1234').replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.logger = options.logger;
  }

  setModel(model: string): void {
    if (model && model.trim()) {
      this.model = model.trim();
    }
  }

  getModel(): string {
    return this.model;
  }

  setBaseUrl(baseUrl: string): void {
    if (baseUrl && baseUrl.trim()) {
      this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Invokes the LM Studio OpenAI-compatible /v1/chat/completions endpoint.
   * Employs exponential backoff retry logic.
   */
  async invoke(context: ModelRequestContext): Promise<ModelResponse> {
    let textPrompt = context.description;
    if (context.fileContext !== undefined && context.fileContext !== null) {
      textPrompt += `\n\nFile Context:\n${JSON.stringify(context.fileContext, null, 2)}`;
    }

    // Build message content supporting text and optional multimodal vision
    let userContent: any;
    if (context.image) {
      userContent = [
        { type: 'text', text: textPrompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:${context.image.mediaType};base64,${context.image.base64}`,
          },
        },
      ];
    } else {
      userContent = textPrompt;
    }

    const body = JSON.stringify({
      model: this.model,
      messages: [{ role: 'user', content: userContent }],
      stream: false,
    });

    let attempt = 0;
    const maxRetries = this.maxRetries;

    while (true) {
      try {
        attempt++;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
          response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => '(unreadable body)');
          throw new LMStudioConnectorError(
            `LM Studio returned HTTP ${response.status}: ${errText}`
          );
        }

        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          error?: { message?: string } | string;
        };

        if (json.error) {
          const errMsg = typeof json.error === 'string' ? json.error : json.error.message;
          throw new LMStudioConnectorError(`LM Studio API error: ${errMsg}`);
        }

        const text = json.choices?.[0]?.message?.content;
        if (text === undefined || text === null) {
          throw new LMStudioConnectorError('LM Studio response contained no message content.');
        }

        return {
          text,
          raw: json,
        };
      } catch (err: any) {
        const isLastAttempt = attempt >= maxRetries;
        if (isLastAttempt) {
          this.logger?.error(
            { err: redactSecrets(err), attempt, maxRetries },
            'LM Studio invocation failed after max retries.'
          );
          if (err instanceof LMStudioConnectorError) {
            throw err;
          }
          throw new LMStudioConnectorError(`LM Studio request failed: ${err.message}`);
        }

        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        this.logger?.warn(
          { attempt, backoffMs, err: err.message },
          'LM Studio invocation attempt failed, retrying...'
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
}
