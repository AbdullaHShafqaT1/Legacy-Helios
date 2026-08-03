# Legacy's Helios - Architecture Decision Records (ADRs)

This directory documents the technical decisions, design trade-offs, and architecture pivots made over the lifecycle of **Legacy's Helios**.

## ADR Status Definitions

- **Proposed**: Under review and open for feedback.
- **Accepted**: Decision approved and active.
- **Deprecated**: Decision superseded by a newer ADR.
- **Rejected**: Proposal rejected with rationale.

## ADR Log

| ID | Title | Status | Date | Summary |
|---|---|---|---|---|
| 0001 | Initial Repository Structure | Accepted | 2026-07-10 | Settled on monorepo design separating apps, services, agents, tools, prompts, memory, and connectors. |
| 0002 | SQLite JSON Cosine Vector Store | Accepted | 2026-08-03 | Selected custom SQLite-backed vector store with JSON float arrays and brute-force cosine similarity. |

*To create a new decision record, copy the standard template `0000-template.md` and increment the ID.*
