# Legacy's Predator - Architecture Documentation

This directory contains detailed technical documentation of the system architecture of **Legacy's Predator**.

## Directory Contents

- [System Architecture Overview](../../ARCHITECTURE.md) - Root architecture summary.
- Subsystem Designs (TBD):
  - **Orchestration & Kernel**: Microkernel design for agent process scheduling.
  - **Memory & Context**: Layered storage (short-term, long-term semantic, episodic memory).
  - **Tools Execution Environment**: Sandboxed shell, compiler, and API execution.
  - **Connectors**: Standardized interface definitions for foreign agents and platforms.

## Proposed Component Architecture

```
                 +---------------------------------------+
                 |            User Interface             |
                 |       (CLI / GUI / API Client)        |
                 +-------------------+-------------------+
                                     |
                                     v
                 +-------------------+-------------------+
                 |           Core Orchestrator           |
                 |      (Agent Coordinator & Router)     |
                 +----------+--------+--------+----------+
                            |        |        |
         +------------------+        |        +------------------+
         |                           v                           |
+--------v---------+       +---------v--------+       +----------v-------+
|   Agent Kernel   |       |   Memory Layer   |       |   Tool Runtime   |
| (LLM Controller) |       | (Vector/SQL/KV)  |       | (Sandboxed Env)  |
+--------+---------+       +---------+--------+       +----------+-------+
         |                           |                           |
         v                           v                           v
+--------+---------+       +---------+--------+       +----------+-------+
|   Connectors     |       |   Prompts DB     |       |   Native Tools   |
| (APIs/Webhooks)  |       | (Versioned Templ)|       | (Git/Shell/etc)  |
+------------------+       +------------------+       +------------------+
```

*Note: Detailed specifications for each block will be documented in respective subfiles.*
