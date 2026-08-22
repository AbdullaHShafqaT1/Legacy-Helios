# ADR 0003: Autonomous Web Research and Ingested Content Safety

- **Status**: Accepted
- **Date**: 2026-08-22
- **Decided By**: Jarvis Architecture Team

---

## Context and Problem Statement

For Phase 13 (Autonomous Web Research), the Researcher Agent requires outbound web access capabilities to search and ingest online scientific literature, documentation, and technical sources. 

A primary requirement is providing out-of-the-box search capabilities without demanding third-party API keys (like Tavily) as a mandatory prerequisite, while defending the core agent prompt against adversarial prompt-injection payloads embedded in untrusted external web content.

---

## Decision

We implemented a unified `SearchConnector` supporting dual providers:
1.  **Tavily API**: Used as the primary cloud research provider when `JARVIS_TAVILY_API_KEY` is configured.
2.  **DuckDuckGo Scraper (Fallback)**: Used as the default out-of-the-box provider. It makes a real HTTP GET request to `html.duckduckgo.com`, parses the resulting HTML structure to extract result titles and snippet blocks, and resolves the destination URLs by parsing the redirect parameter (`uddg`).

To maintain ingested content safety:
*   All ingested search content is fed through `redactSecrets` recursively to prevent secret leaks.
*   Retrieved snippets are wrapped inside strict `<untrusted-web-content>` XML boundaries before being fed to the model router.
*   System instructions explicitly direct the LLM to treat content within this tag strictly as data and ignore any system commands or prompt-injection directives (e.g. "ignore previous instructions").
*   Rate limiting is enforced system-wide by querying the SQLite `audit_log` database timestamps.

---

## Rationale and Alternatives Considered

1.  **Synthetic/Mock Default Results**:
    *   *Rejected*: Fabricating synthetic search results presents misleading or false citations to the agent, violating the requirement for genuine autonomous research.
2.  **Third-Party Search APIs Only (Google/Bing/Tavily)**:
    *   *Rejected*: Mandating setup of paid keys prevents immediate out-of-the-box usability for new developers.
3.  **Real DuckDuckGo Scraper + Gated Policies (Chosen)**:
    *   *Accepted*: Leverages public HTML search pages directly, ensuring out-of-the-box execution. Restricting web-search under a guarded policy limits potential search query egress, while XML wrapping mitigates prompt-injection attacks.

---

## Consequences and Trade-offs

*   **HTML Scraper Fragility**: DuckDuckGo's HTML structure could change, which might break the regex parsing block. If this occurs, the parser will fail gracefully and prompt the user to configure a robust cloud key (Tavily).
*   **Prompt-Injection Risk**: While XML wrapping and model steering instructions significantly mitigate prompt-injection attacks, mitigation remains partial and dependent on LLM compliance. Gating and rate limits prevent runaway command abuse.
