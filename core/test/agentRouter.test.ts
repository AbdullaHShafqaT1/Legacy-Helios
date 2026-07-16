import { describe, it, expect } from 'vitest';
import { AgentRouter, AgentRouterError } from '../src/router/agentRouter.js';
import { Agent, AgentTaskInput, AgentResult } from '../../agents/shared/Agent.js';

describe('AgentRouter Class', () => {
  const createMockAgent = (name: string): Agent => ({
    name,
    process: async (input: AgentTaskInput): Promise<AgentResult> => ({
      status: 'completed',
      filesChanged: [],
      explanation: `Processed by ${name}`,
    }),
  });

  it('should throw AgentRouterError if resolve is called with no registered agents', () => {
    const router = new AgentRouter();
    expect(() => router.resolve()).toThrow(AgentRouterError);
  });

  it('should register an agent and resolve it as the default', () => {
    const router = new AgentRouter();
    const agent = createMockAgent('agent-1');
    router.register(agent);

    const resolved = router.resolve();
    expect(resolved.name).toBe('agent-1');
  });

  it('should not change the default agent when registering a secondary agent without isDefault', () => {
    const router = new AgentRouter();
    const agent1 = createMockAgent('agent-1');
    const agent2 = createMockAgent('agent-2');

    router.register(agent1);
    router.register(agent2); // Registers but does not mark default

    const resolved = router.resolve();
    expect(resolved.name).toBe('agent-1');
  });

  it('should change the default agent when registering a secondary agent with isDefault', () => {
    const router = new AgentRouter();
    const agent1 = createMockAgent('agent-1');
    const agent2 = createMockAgent('agent-2');

    router.register(agent1);
    router.register(agent2, { isDefault: true });

    const resolved = router.resolve();
    expect(resolved.name).toBe('agent-2');
  });
});
