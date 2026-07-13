import { describe, it, expect, vi } from 'vitest';
import { ClaudeConnector, ClaudeConnectorError } from '../../connectors/claude-api/ClaudeConnector.js';
import { createLogger } from '../src/lib/logger.js';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      return {
        messages: {
          create: mockCreate
        }
      };
    })
  };
});

describe('ClaudeConnector', () => {
  it('should successfully concatenate text content blocks from Claude response', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Hello, ' },
        { type: 'image', source: '...' },
        { type: 'text', text: 'world!' }
      ]
    });

    const logger = createLogger('test-logger', 'silent');
    const connector = new ClaudeConnector({
      apiKey: 'sk-ant-testkey',
      model: 'claude-3-5-sonnet-latest',
      maxRetries: 1,
      logger
    });

    const response = await connector.invoke({ description: 'Greet' });
    expect(response.text).toBe('Hello, world!');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Greet' }]
    });
  });

  it('should support appending JSON file context to the prompt description', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Clean context' }]
    });

    const logger = createLogger('test-logger', 'silent');
    const connector = new ClaudeConnector({
      apiKey: 'sk-ant-testkey',
      model: 'claude-3-5-sonnet-latest',
      maxRetries: 1,
      logger
    });

    await connector.invoke({
      description: 'Analyze file',
      fileContext: { filename: 'config.json', size: 120 }
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArg = mockCreate.mock.calls[0][0] as any;
    expect(callArg.messages[0].content).toContain('Analyze file');
    expect(callArg.messages[0].content).toContain('File Context:');
    expect(callArg.messages[0].content).toContain('config.json');
  });

  it('should retry a failing call and throw ClaudeConnectorError after exhausting retries, redacting the API key', async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(new Error('Anthropic API limit reached'));

    const warnSpy = vi.fn();
    const mockLogger = {
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    } as any;

    const connector = new ClaudeConnector({
      apiKey: 'sk-ant-test-api-key-leak',
      model: 'claude-3-5-sonnet-latest',
      maxRetries: 2, // 1 initial + 2 retries = 3 attempts total
      logger: mockLogger
    });

    vi.useFakeTimers();

    const invokePromise = connector.invoke({ description: 'Fail test' });
    const expectation = expect(invokePromise).rejects.toThrow(ClaudeConnectorError);

    // Exhaust delays
    await vi.runAllTimersAsync();

    await expectation;

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(3);

    // Verify warnings redact the API key
    warnSpy.mock.calls.forEach(call => {
      const logObject = call[0];
      const logString = JSON.stringify(logObject);
      expect(logString).not.toContain('sk-ant-test-api-key-leak');
      expect(logString).toContain('[REDACTED]');
    });

    vi.useRealTimers();
  });
});
