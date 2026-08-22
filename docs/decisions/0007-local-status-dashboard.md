# ADR 0007: Local Status Dashboard

- **Status**: Accepted
- **Date**: 2026-08-22
- **Decided By**: Jarvis Architecture Team

---

## Context and Problem Statement

For Phase 15, Jarvis requires a Local Status Dashboard providing a live web UI to monitor system status, active workspaces, recent task logs, and periodic screenshot capture feeds. Additionally, it must allow interactive user confirmations of pending actions (like terminal execution approval).

Introducing a network-facing interface expands the security attack surface. We must enforce strict security boundaries, preventing unauthorized remote access while ensuring voice-cannot-approve safeguards remain intact.

---

## Decision

We chose to implement a lightweight, local-loopback-only HTTP and WebSocket server inside `DashboardServer.ts`.

* **Loopback Binding Safety**:
  * The server binds strictly to the loopback interface (`127.0.0.1` or `::1`) on the port specified by `JARVIS_DASHBOARD_PORT` (default `8086`).
  * Any request headers or sockets originating from non-localhost IP addresses are rejected with `403 Forbidden` immediately.
* **WebSocket Live Stream**:
  * Leverages Node's standard `http` library and the `ws` package, avoiding heavy framework installations.
  * Streams real-time updates when database entries or health statuses transition.
* **Screenshot Gating**:
  * Screenshot images served by the dashboard endpoint must be fetched exclusively from the retention cache of `PeriodicCaptureManager` (whose capture loop is already authorized and gated under `'vision-periodic-start'`).
  * Text descriptions and parameters displayed on the dashboard are recursively filtered through `redactSecrets` to prevent credential leakage.
* **Voice-Cannot-Approve Enforcement**:
  * Dashboard approvals update the `pending_approvals` table. Gated orchestrator tasks check this status.
  * If a task's source is marked as `'voice'`, the dashboard server blocks the approval request, returning a `403 Forbidden` error. This preserves the voice-cannot-approve boundary, forcing users to use standard text/CLI overrides.

---

## Rationale and Alternatives Considered

1. **Heavy Web Frameworks (e.g. Next.js / Express)**:
   * *Rejected*: Installs dozens of heavy dependency packages, introducing vulnerability friction and setup lag. Native `http` + `ws` is self-contained and highly performant.
2. **Dynamic CORS allow-lists**:
   * *Rejected*: Exposes the port to cross-origin scripting vectors. Restricting the server exclusively to loopback loop and rejecting non-localhost clients is the most robust security profile.

---

## Consequences and Trade-offs

* **CLI Equivalent Security Class**: The dashboard is bound to localhost loopback, keeping access restricted to the logged-in OS user. Clicking "Approve" is therefore equivalent to running `jarvis approve <taskId>` in a local shell.
* **Unattended Mode Dependency**: Gated actions are only queued for dashboard resolution if the system is running in unattended mode (`JARVIS_UNATTENDED=true`) or if tasks originate from voice, as standard interactive mode handles prompts inline in the terminal.
