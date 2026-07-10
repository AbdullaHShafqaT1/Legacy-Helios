# System Architecture

This document describes the architectural layout, system components, and interaction patterns within **Legacy's Helios**.

---

## Architecture Overview

Helios OS follows a modular microkernel design. The core engine is thin and focused solely on process management (agent executions), event routing, and resource authorization. All utility systems (databases, tools, vector indexing, web servers) are decoupled and run as separate services or connectors.

```
+-----------------------------------------------------------------+
|                         USER INTERFACE                          |
|             Terminal UI (CLI) / Web Admin Dashboard             |
+--------------------------------+--------------------------------+
                                 |
                                 v
+--------------------------------+--------------------------------+
|                         OS MICROKERNEL                          |
|          Process Scheduler  |  Event Router  |  ACL Manager     |
+-------+------------------------+------------------------+-------+
        |                        |                        |
        v                        v                        v
+-------+--------+       +-------+--------+       +-------+-------+
|  AGENT RUNTIME |       |  MEMORY KERNEL |       | TOOL GATEWAY  |
|  LLM Wrappers  |       | Redis / Vector |       | Local Sandbox |
+----------------+       +----------------+       +---------------+
```

---

## Core Components

### 1. Process Scheduler (Agent Runtime)
The Agent Runtime is responsible for executing agent loops.
- **Cycles**: A cycle represents a single inference step: *Observation -> Thought -> Action -> Verification*.
- **Priority**: System scheduler assigns token allocation priorities based on task importance.
- **State Serialization**: Agent runtime states are saved as serialized checkpoints, enabling agents to hibernate and resume later.

### 2. Memory Access Layer
Memory is isolated and managed through three distinct caches:
- **L1 Cache (Working Memory)**: Temporary buffer containing the direct conversation/context window of the active LLM run.
- **L2 Cache (Episodic Memory)**: Relational SQLite database recording exact historical execution cycles and tool results.
- **L3 Cache (Semantic Memory)**: Vector database storing embeddings of long-term instructions, documentation, and system knowledge.

### 3. Tool Gatekeeper
Security is guaranteed by restricting access to operating system components.
- **Interpreters**: Agent commands (Python code, terminal actions) execute within isolated container runtimes or virtualized shells.
- **Permissions**: Every tool execution must be checked against user-defined permission configuration rules.

### 4. Connectors
Driver plugins that interface the operating system with the outside world.
- **Github API**: Allows agents to search, clone, commit, and open PRs.
- **Web Browsers**: Uses Playwright/Puppeteer wrappers inside safe Docker images to parse public web pages.
