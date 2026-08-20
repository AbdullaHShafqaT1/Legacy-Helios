import { Logger } from 'pino';
import { ModelRoute, ModelRequestContext, ModelResponse, TaskType } from '../../core/src/router/modelRouter.js';

export class OllamaConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaConnectorError';
    Object.setPrototypeOf(this, OllamaConnectorError.prototype);
  }
}

export class OllamaConnector implements ModelRoute {
  taskTypes: TaskType[] = ['coding', 'reasoning', 'vision'];

  private model: string;
  private baseUrl: string;
  private maxRetries: number;
  private timeoutMs: number;
  private logger: Logger;

  constructor(options: {
    model?: string;
    baseUrl?: string;
    maxRetries?: number;
    timeoutMs?: number;
    logger: Logger;
  }) {
    this.model = options.model ?? 'llava:latest';
    this.baseUrl = options.baseUrl ?? 'http://localhost:11434';
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 120000; // local models can be slower
    this.logger = options.logger;
  }

  /**
   * Invokes the Ollama model via its /api/chat endpoint.
   * Supports both text and vision (image) requests for llava.
   * Employs exponential backoff retry logic.
   *
   * @param context The request parameters.
   * @returns A promise resolving to the model response.
   * @throws OllamaConnectorError if all retries are exhausted.
   */
  async invoke(context: ModelRequestContext): Promise<ModelResponse> {
    let textPrompt = context.description;
    if (context.fileContext !== undefined && context.fileContext !== null) {
      textPrompt += `\n\nFile Context:\n${JSON.stringify(context.fileContext, null, 2)}`;
    }

    // Build the message payload for Ollama's /api/chat endpoint
    const userMessage: Record<string, unknown> = {
      role: 'user',
      content: textPrompt,
    };

    // llava supports images via the `images` field (array of base64 strings)
    if (context.image) {
      userMessage.images = [context.image.base64];
    }

    const body = JSON.stringify({
      model: this.model,
      messages: [userMessage],
      stream: false,
    });

    let attempt = 0;

    while (true) {
      try {
        attempt++;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
          response = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => '(unreadable body)');
          throw new OllamaConnectorError(
            `Ollama returned HTTP ${response.status}: ${errText}`
          );
        }

        const json = (await response.json()) as {
          message?: { content?: string };
          error?: string;
        };

        if (json.error) {
          throw new OllamaConnectorError(`Ollama error: ${json.error}`);
        }

        const text = json.message?.content ?? '';
        return { text, raw: json };

      } catch (error: any) {
        this.logger.warn(
          { error: error?.message, attempt, maxRetries: this.maxRetries, model: this.model },
          `Ollama API call failed on attempt ${attempt}.`
        );

        if (attempt > this.maxRetries) {
          throw new OllamaConnectorError(
            `Ollama call failed after ${attempt} attempts. Original error: ${error?.message ?? error}`
          );
        }

        // Exponential backoff: base 500ms, doubling each attempt
        const delay = 500 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}
