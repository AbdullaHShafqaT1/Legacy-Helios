import { Agent } from '../../../agents/shared/Agent.js';

export class AgentRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRouterError';
    Object.setPrototypeOf(this, AgentRouterError.prototype);
  }
}

export class AgentRouter {
  private agents = new Map<string, Agent>();
  private defaultAgentName: string | null = null;

  /**
   * Registers a worker agent in the router.
   *
   * @param agent The agent instance.
   * @param opts Optional parameters to set this agent as the default candidate.
   */
  register(agent: Agent, opts?: { isDefault?: boolean }): void {
    this.agents.set(agent.name, agent);
    
    if (opts?.isDefault || !this.defaultAgentName) {
      this.defaultAgentName = agent.name;
    }
  }

  /**
   * Resolves the agent.
   *
   * DESIGN DECISION: Phase 1 Routing Limitation
   * In Phase 1, Jarvis has exactly one agent registered, so we resolve to the default agent.
   * In later phases, this resolution method will inspect task metadata or descriptions and route
   * tasks dynamically to specific agents (e.g. software engineer, researcher, review agent) matching
   * required skills.
   *
   * @returns The resolved Agent.
   * @throws AgentRouterError if no default agent is registered.
   */
  resolve(): Agent {
    if (!this.defaultAgentName) {
      throw new AgentRouterError('No worker agents have been registered in the AgentRouter.');
    }

    const defaultAgent = this.agents.get(this.defaultAgentName);
    if (!defaultAgent) {
      throw new AgentRouterError(`Default agent "${this.defaultAgentName}" is not registered in the agent list.`);
    }

    return defaultAgent;
  }
}
