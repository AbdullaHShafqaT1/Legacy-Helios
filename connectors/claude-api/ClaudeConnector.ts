import Anthropic from '@anthropic-ai/sdk';
import { Logger } from 'pino';
import { ModelRoute, ModelRequestContext, ModelResponse, TaskType } from '../../core/src/router/modelRouter.js';
import { redactSecrets } from '../../core/src/lib/redact.js';

export class ClaudeConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeConnectorError';
    Object.setPrototypeOf(this, ClaudeConnectorError.prototype);
  }
}

export class ClaudeConnector implements ModelRoute {
  taskTypes: TaskType[] = ['coding', 'reasoning'];
  private apiKey: string;
  private model: string;
  private maxRetries: number;
  private logger: Logger;
  private client: Anthropic;

  constructor(options: {
    apiKey: string;
    model: string;
    maxRetries?: number;
    logger: Logger;
  }) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new ClaudeConnectorError('API key must be provided.');
    }
    if (!options.model || options.model.trim() === '') {
      throw new ClaudeConnectorError('Model name must be provided.');
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 3;
    this.logger = options.logger;
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  /**
   * Invokes the Claude message completion endpoint with the description and context.
   * Employs exponential backoff retry logic.
   *
   * @param context The request parameters.
   * @returns A promise resolving to the model response.
   * @throws ClaudeConnectorError if all retries are exhausted.
   */
  async invoke(context: ModelRequestContext): Promise<ModelResponse> {
    let prompt = context.description;
    if (context.fileContext !== undefined && context.fileContext !== null) {
      prompt += `\n\nFile Context:\n${JSON.stringify(context.fileContext, null, 2)}`;
    }

    let attempt = 0;
    const retriesLimit = this.maxRetries;

    while (true) {
      try {
        attempt++;
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }]
        });

        // Extract and concatenate all text blocks
        const text = response.content
          .filter(block => block.type === 'text')
          .map(block => (block as any).text)
          .join('');

        return {
          text,
          raw: response
        };
      } catch (error: any) {
        // Redact any secrets before logging
        const redactedError = redactSecrets(error);
        const redactedParams = redactSecrets({
          model: this.model,
          max_tokens: 4096,
          promptLength: prompt.length
        });

        this.logger.warn(
          {
            error: redactedError,
            params: redactedParams,
            attempt,
            maxRetries: retriesLimit
          },
          `Claude API call failed on attempt ${attempt}.`
        );

        if (attempt > retriesLimit) {
          throw new ClaudeConnectorError(
            `Claude API call failed after ${attempt} attempts. Original error: ${error?.message || error}`
          );
        }

        // Exponential backoff: base 500ms, doubling on each attempt
        const delay = 500 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}
