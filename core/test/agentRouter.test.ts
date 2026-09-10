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

  const mockTask = (description: string, fileContext?: string): any => ({
    id: 't-1',
    description,
    file_context: fileContext || null,
    status: 'pending',
    priority: 0,
    depends_on: null,
    retries: 0,
    max_retries: 3,
    error: null,
    result_json: null,
    locked_by: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sequence_id: 1
  });

  it('should throw AgentRouterError if resolve is called with no registered agents', () => {
    const router = new AgentRouter();
    expect(() => router.resolve(mockTask('test'))).toThrow(AgentRouterError);
  });

  it('should register an agent and resolve it as the default', () => {
    const router = new AgentRouter();
    const agent = createMockAgent('agent-1');
    router.register(agent);

    const resolved = router.resolve(mockTask('test'));
    expect(resolved.name).toBe('agent-1');
  });

  it('should not change the default agent when registering a secondary agent without isDefault', () => {
    const router = new AgentRouter();
    const agent1 = createMockAgent('agent-1');
    const agent2 = createMockAgent('agent-2');

    router.register(agent1);
    router.register(agent2); // Registers but does not mark default

    const resolved = router.resolve(mockTask('test'));
    expect(resolved.name).toBe('agent-1');
  });

  it('should change the default agent when registering a secondary agent with isDefault', () => {
    const router = new AgentRouter();
    const agent1 = createMockAgent('agent-1');
    const agent2 = createMockAgent('agent-2');

    router.register(agent1);
    router.register(agent2, { isDefault: true });

    const resolved = router.resolve(mockTask('test'));
    expect(resolved.name).toBe('agent-2');
  });

  it('should route desktop tasks correctly via file_context and keywords', () => {
    const router = new AgentRouter();
    const defaultAgent = createMockAgent('software-engineer');
    const desktopAgent = createMockAgent('desktop-operator');
    const browserAgent = createMockAgent('browser-operator');
    const terminalAgent = createMockAgent('terminal-operator');

    router.register(defaultAgent, { isDefault: true });
    router.register(desktopAgent);
    router.register(browserAgent);
    router.register(terminalAgent);

    // Tagged description
    expect(router.resolve(mockTask('[desktop] Open youtube')).name).toBe('desktop-operator');
    expect(router.resolve(mockTask('#desktop Click button')).name).toBe('desktop-operator');

    // Natural language keywords
    expect(router.resolve(mockTask('Open a new tab in the active browser, navigate to youtube.com')).name).toBe('desktop-operator');
    expect(router.resolve(mockTask('Click the chrome icon on the desktop screen')).name).toBe('desktop-operator');

    // File context routing
    expect(router.resolve(mockTask('Perform action', JSON.stringify({ agent: 'desktop-operator' }))).name).toBe('desktop-operator');
    expect(router.resolve(mockTask('Perform action', JSON.stringify({ target: 'desktop' }))).name).toBe('desktop-operator');
    expect(router.resolve(mockTask('Run command', JSON.stringify({ target: 'terminal' }))).name).toBe('terminal-operator');
    expect(router.resolve(mockTask('Browse website', JSON.stringify({ target: 'browser' }))).name).toBe('browser-operator');
  });
});
