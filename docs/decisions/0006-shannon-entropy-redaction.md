# ADR 0006: Entropy-Based Secrets Redaction

- **Status**: Accepted
- **Date**: 2026-08-22
- **Decided By**: Jarvis Architecture Team

---

## Context and Problem Statement

As of Phase 3, Jarvis secrets redaction (`redactSecrets` inside `core/src/lib/redact.ts`) was restricted to regex pattern matching for known key prefixes (e.g. `sk-ant-` Anthropic keys) and object key name matching (e.g. `api_key`, `password`, `token`). 

This pattern matching is blind to unlabeled high-entropy secrets (like password hashes, raw AWS credentials, or OAuth tokens) that are passed in raw strings without matching object key labels. To harden the security perimeter, we need a mechanism to identify and mask arbitrary high-entropy string runs inside all redacted data streams (logs, terminal output, files, screenshots).

---

## Decision

We chose to implement a secondary **Shannon-Entropy Token Redaction** pass inside the `redactSecrets` pipeline.

* **Shannon Entropy Helper**: We calculate the statistical variety of characters inside individual string tokens:
  $H(X) = - \sum P(x_i) \log_2 P(x_i)$
* **Tuning Parameters**:
  * We tokenize strings using the regex `/[a-zA-Z0-9_\-\/\+=]{16,128}/g`, which selectively isolates contiguous alphanumeric/base64 runs.
  * For each extracted token, we calculate its entropy. If it exceeds the configurable threshold `JARVIS_REDACTION_ENTROPY_THRESHOLD` (defaulting to `3.7`), we mask it as `[REDACTED]`.
* **Complementary Execution**:
  * We keep the regex shape matchers active as a primary pass. This ensures that repeating or low-entropy key strings (e.g. `sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`) are still caught even if their computed Shannon entropy falls below `3.7`.

---

## Rationale and Alternatives Considered

1. **AST / Semantic Token Scans (e.g. using Babel / Esprima)**:
   * *Rejected*: Disclosed as out of reach for a lightweight, runtime log utility. Spawning full parser scans on every stdout chunk is computationally slow and fails to parse arbitrary non-code files or natural language prose.
2. **Shannon Entropy (Chosen)**:
   * *Accepted*: Instantly computable, lightweight, handles arbitrary logs and unstructured text formats, and detects keys of any shape.

---

## Consequences and Trade-offs

* **Zero-False Positives on Natural Language**: By constraining token evaluation to runs of length $\ge 16$ characters, normal English words (which average 5 characters) are skipped entirely.
* **Tuning Threshold (3.7)**: A threshold of `3.7` represents the optimal boundary. Natural long words (like `incomprehensibilities` or `floccinaucinihilipilification`) exhibit entropy of `2.9` to `3.1` (due to repeating character frequencies) and pass untouched. In contrast, 32-character hexadecimal strings (maximum entropy `4.0`) and base64 strings (entropy `4.2` to `4.8`) trigger masking successfully.
* **Limitations**: Unlabeled secrets with very low entropy (such as dictionary words like `"mypassword12345"`) will bypass this check. However, since key-value configurations are caught by the primary regex key-name parser, this is an acceptable residual risk.
