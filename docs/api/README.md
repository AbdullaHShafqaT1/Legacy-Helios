# Legacy's Predator - API Specifications

This directory contains the specifications for the APIs exposed by the **Legacy's Predator** operating system layer.

## Core API Interfaces

### 1. Agent Runtime API
Used by external apps to instantiate, command, and inspect autonomous agents.
* **Protocols**: REST (JSON) / WebSockets for streaming.
* **Endpoints (Planned)**:
  - `POST /api/v1/agents` - Create an agent instance.
  - `POST /api/v1/agents/{id}/execute` - Send instructions/commands.
  - `GET /api/v1/agents/{id}/stream` - Stream execution logs, thoughts, and outputs.

### 2. Tools SDK
Standard library interface for registering third-party tools to the system.
* **SDK bindings**: Python, TypeScript, and Go.

### 3. Memory Access Layer
API interface for querying context databases and episodic memory files.
