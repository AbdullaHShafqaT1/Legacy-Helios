# Agent Specification & Design Patterns

This document defines the interface standards, state machine patterns, and persona structures for autonomous agents running on **Legacy's Helios**.

---

## 🧠 Agent Design Philosophy

Agents in Helios OS are modelled as isolated runtime processes. Each agent possesses:
1. **Persona Schema**: A descriptive blueprint defining the system instructions, tone, and operational boundaries of the agent.
2. **State Machine**: An event-driven state router (e.g. *Idle -> Initializing -> Executing -> Reasoning -> Evaluating -> Completed*).
3. **Tool Access Scope**: A strictly defined whitelist of executable tools.

---

## ⚙️ Planned Agent Interface Schema

Every agent should implement a standardized structure (expressed here in Python-style type schemas):

```python
from typing import Dict, List, Any
from dataclasses import dataclass

@dataclass
class AgentMetadata:
    id: str
    name: str
    version: str
    role: str
    description: str

class BaseAgent:
    def __init__(self, metadata: AgentMetadata, system_prompt: str, tools: List[str]):
        self.metadata = metadata
        self.system_prompt = system_prompt
        self.allowed_tools = tools
        self.state = "idle"

    async def step(self, observation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes a single cycle step of the agent.
        Returns the action name and parameters to be executed.
        """
        raise NotImplementedError
```

---

## 🤝 Inter-Agent Communication (Swarm Routing)

When agents work together in a swarm, they route tasks using a publish-subscribe communication pattern:

1. **Coordinator Agent**: Receives root developer prompt, decomposes it into dependency trees of subtasks.
2. **Worker Agents**: Subscribed to specific task types (e.g., `code-generation`, `code-review`, `database-design`).
3. **Message Router**: Evaluates task completions and forwards state updates.
