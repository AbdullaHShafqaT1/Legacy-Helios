import { Agent } from '../../../agents/shared/Agent.js';
import { TaskRow } from '../queue/index.js';

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
   * Exposes an agent instance by name.
   */
  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  /**
   * Resolves the agent to process a task based on fileContext metadata or description tags.
   *
   * @param task The task database row.
   * @returns The resolved Agent.
   * @throws AgentRouterError if no matching agent is registered.
   */
  resolve(task: TaskRow): Agent {
    let agentName = this.defaultAgentName;

    // 1. Check file_context properties
    if (task.file_context) {
      try {
        const fileCtx = JSON.parse(task.file_context);
        const target = fileCtx.taskType || fileCtx.agent;
        if (target) {
          agentName = this.mapTargetToAgentName(target);
        }
      } catch {
        // Fallback on parsing error
      }
    }

    // 2. Parse description prefixes/tags if still default/unset
    if (agentName === this.defaultAgentName) {
      const desc = task.description.toLowerCase();
      if (desc.includes('[research]') || desc.includes('#research')) {
        agentName = 'researcher';
      } else if (
        desc.includes('[review]') ||
        desc.includes('#review') ||
        desc.includes('[code-reviewer]') ||
        desc.includes('#code-reviewer')
      ) {
        agentName = 'code-reviewer';
      } else if (
        desc.includes('[pm]') ||
        desc.includes('#pm') ||
        desc.includes('[project-manager]') ||
        desc.includes('#project-manager')
      ) {
        agentName = 'project-manager';
      } else if (
        desc.includes('[coding]') ||
        desc.includes('#coding') ||
        desc.includes('[software-engineer]') ||
        desc.includes('#software-engineer')
      ) {
        agentName = 'software-engineer';
      }
    }

    const agent = agentName ? this.agents.get(agentName) : null;
    if (!agent) {
      if (this.defaultAgentName) {
        const fallback = this.agents.get(this.defaultAgentName);
        if (fallback) return fallback;
      }
      throw new AgentRouterError(`Resolved agent "${agentName}" is not registered, and no default agent is available.`);
    }

    return agent;
  }

  private mapTargetToAgentName(target: string): string {
    const normalized = target.toLowerCase();
    if (normalized === 'coding' || normalized === 'software-engineer') {
      return 'software-engineer';
    }
    if (normalized === 'research' || normalized === 'researcher') {
      return 'researcher';
    }
    if (normalized === 'review' || normalized === 'code-reviewer' || normalized === 'reviewer') {
      return 'code-reviewer';
    }
    if (normalized === 'pm' || normalized === 'project-manager') {
      return 'project-manager';
    }
    return target;
  }
}
