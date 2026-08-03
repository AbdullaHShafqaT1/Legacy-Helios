# ADR 0002: SQLite JSON Cosine Vector Store (sqlite-json-cosine)

- **Status**: Accepted
- **Date**: 2026-08-03
- **Decided By**: Jarvis Architecture Team

---

## Context and Problem Statement

For Phase 3 (Semantic Memory and Context Preservation), Jarvis requires a local-first vector memory storage and retrieval mechanism. The memory pipeline must convert text inputs into numerical feature vectors (embeddings) and support semantic retrieval via cosine similarity matching. 

A primary constraint is maintaining local-first simplicity, rapid test cycles in-memory (using Vitest), and cross-platform installation compatibility (such as Windows, macOS, and Linux) without requiring external vector database server processes or heavy native-binary pre-requisites.

---

## Decision

We chose to implement a custom SQLite-backed vector store, configured as type `'sqlite-json-cosine'`. 

* Embeddings are stored as serialized JSON float arrays (e.g. `[0.12, -0.05, ...]`) in a dedicated `vectors` table in SQLite.
* Cosine similarity comparisons are computed dynamically in application memory (JavaScript/TypeScript space) over the retrieved vector records.
* This naming was explicitly corrected from the initial draft (which incorrectly referenced `'sqlite-vss'`) to reflect that it is a custom application-level cosine similarity engine rather than the compiled C++ `sqlite-vss` extension.

---

## Rationale and Alternatives Considered

1. **Standalone Vector Database (e.g. ChromaDB, Milvus, Qdrant)**:
   * *Rejected*: These databases run as external server processes or rely on native binary daemons. This introduces complex environment configuration requirements, startup latency, and testing friction.
2. **`sqlite-vss` C++ extension**:
   * *Rejected*: `sqlite-vss` is a powerful SQLite extension utilizing Faiss. However, loading dynamic libraries in Node.js across Windows, Linux, and macOS introduces compilation friction, binary toolchain dependencies, and version mismatch issues. This is particularly problematic since cross-platform verification has been deferred to Phase 5.
3. **Custom SQLite JSON + Cosine Similarity (Chosen)**:
   * *Accepted*: High portability (built on standard `better-sqlite3` queries), zero dynamic library compiler hurdles, works natively on Windows, macOS, and Linux, and supports standard `:memory:` databases for fast unit/integration testing under Vitest.

---

## Consequences and Trade-offs

* **Linear-Scan Query Complexity**: Searching requires a brute-force linear scan over all vectors in the store. The store retrieves all JSON-serialized vectors and computes cosine similarity in JS/TS.
* **Scale Mitigation**: While $O(N)$ scan cost is highly efficient for typical developer workspace contexts (thousands of entries take less than 10ms to query), it will not scale to millions of high-dimensional vectors. If database size grows significantly, we will need to optimize the store or transition to a specialized index.
* **Strict Decoupling**: The main database relational entries table (`memory_entries`) links to the vector store (`vectors` table) using a standard string identifier `id`. This maintains clean component separation, making it simple to replace `SqliteVectorStore` with an indexed store in the future without modifying the agent routing or database layer.
