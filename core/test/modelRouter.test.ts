import { describe, it, expect } from 'vitest';
import { ModelRouter, ModelRouterError, ModelRoute, ModelRequestContext, ModelResponse } from '../src/router/modelRouter.js';

describe('ModelRouter', () => {
  it('should throw ModelRouterError when no route matches a task type', async () => {
    const router = new ModelRouter();
    await expect(router.route('coding', { description: 'test' })).rejects.toThrow(ModelRouterError);
  });

  it('should route to the correct registered implementation when multiple are registered', async () => {
    const router = new ModelRouter();

    const mockCodingRoute: ModelRoute = {
      taskTypes: ['coding'],
      async invoke(context: ModelRequestContext): Promise<ModelResponse> {
        return { text: `coding: ${context.description}` };
      }
    };

    const mockReasoningRoute: ModelRoute = {
      taskTypes: ['reasoning'],
      async invoke(context: ModelRequestContext): Promise<ModelResponse> {
        return { text: `reasoning: ${context.description}` };
      }
    };

    router.register(mockCodingRoute);
    router.register(mockReasoningRoute);

    const codingRes = await router.route('coding', { description: 'write code' });
    expect(codingRes.text).toBe('coding: write code');

    const reasoningRes = await router.route('reasoning', { description: 'solve logic' });
    expect(reasoningRes.text).toBe('reasoning: solve logic');
  });

  it('should support registering a new route without modifying calling code signature', async () => {
    const router = new ModelRouter();

    // Register initial route
    const firstRoute: ModelRoute = {
      taskTypes: ['coding'],
      async invoke(context: ModelRequestContext): Promise<ModelResponse> {
        return { text: 'first' };
      }
    };
    router.register(firstRoute);

    const firstRes = await router.route('coding', { description: 'test' });
    expect(firstRes.text).toBe('first');

    // Register second route which handles reasoning
    const secondRoute: ModelRoute = {
      taskTypes: ['reasoning'],
      async invoke(context: ModelRequestContext): Promise<ModelResponse> {
        return { text: 'second' };
      }
    };
    router.register(secondRoute);

    // Call routing without changing the signature of router.route
    const codingRes = await router.route('coding', { description: 'test' });
    const reasoningRes = await router.route('reasoning', { description: 'test' });
    expect(codingRes.text).toBe('first');
    expect(reasoningRes.text).toBe('second');
  });
});
