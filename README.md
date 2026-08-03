# Legacy's Helios - Jarvis OS Kernel (Phase 1, Phase 2 & Phase 3 Complete)

> **A modular, autonomous AI Operating System designed for software engineering, automation, scientific research, and deep productivity.**

---

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
[![CI Pipeline](https://github.com/AbdullaHShafqaT1/Legacy-Helios/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)

---

## 👁️ Project Scope & Boundaries

### What Jarvis Phase 1, Phase 2 & Phase 3 IS:
**Jarvis Phase 1, Phase 2 & Phase 3** establish the core operational kernel, permission security layer, local filesystem/git connectors, semantic memory retention, and specialized worker agents:
1. **The Task Queue (`TaskQueue`)**: A relational DAG scheduler running on SQLite (utilizing `better-sqlite3`) with WAL journaling, immutable audit logs via database triggers, priority sorting, retry management, dependency gating, and deterministic same-millisecond FIFO task ordering via monotonic `sequence_id`.
2. **The Model Router (`ModelRouter`)**: A routing facade dispatcher with exponential backoff retries connecting to the Anthropic messages API, supporting `"coding"`, `"reasoning"`, and `"research"` task types.
3. **The Worker Agents**:
   - **`SoftwareEngineerAgent`**: Executes LLM-driven coding requirements, writing and modifying file outputs on disk under strict Permission Gatekeeper gating. Appends recalled semantic memories into the model context, and stores task summaries upon completion.
   - **`ResearcherAgent`**: Evaluates natural-language queries and scoped filesystem context, returning structured research summaries (`summary`, `citations`, `confidence`, `caveats`). Operates with read-only permissions and never attempts mutations. Integrates project-level semantic recall and completion recording.
4. **The Permission Gatekeeper (`PermissionGatekeeper`)**: A 2-step role-based and policy-driven validation barrier intercepting filesystem, git, and memory operations, recording decisions and outcome records in the audit database.
5. **The Connectors**:
   - **`FilesystemConnector`**: Provides project-root scoped read/write/delete access (`listDir`, `readFile`, `writeFile`, `deleteFile`) with strict path-traversal protection and audit logging.
   - **`GitConnector`**: Provides project-root scoped Git operations (`status`, `log`, `diff`, `commit`, `push`, `forcePush`, `resetHard`) with error classification and high-friction confirmation gating for destructive operations.
6. **The Daemon & CLI**: An asynchronous poll loop orchestrator daemon and a 5-command CLI interface (`submit`, `status`, `logs`, `stop`, `help`).
7. **Semantic Memory Manager (`MemoryManager`)**: A local-first semantic memory retrieval pipeline using `SqliteVectorStore` (type `'sqlite-json-cosine'`) to store JSON-serialized embedding float arrays, supporting context recall (via character n-gram TF-IDF embeddings) and automated write integrations on task completion for both Software Engineer and Researcher agents, limited by FIFO eviction policy.

### What Jarvis Phase 1, Phase 2 & Phase 3 is NOT (Deferred to Later Phases):
- **No Voice Interface**: Audio processing is deferred.
- **No Browser Automation / External Web Fetching**: Web browsing agents and ad-hoc HTTP scraping are deferred to Phase 5.
- **No Additional Agent Personas**: Review and QA agent personas are deferred.
- **No External / Dynamic Cloud Vector Database**: ChromaDB, Pinecone, or Milvus are excluded; memory relies strictly on a local-first SQLite file vector database (type `'sqlite-json-cosine'`).
- **No Cross-Process Message Brokers**: Event routing is strictly in-process; Redis/NATS pub-sub is deferred.
- **No Electron/Graphical GUI**: The system runs strictly in TTY terminal environments.
- **No Cloud Deployment / Linux Cross-Platform Verification**: Developed and verified locally on Windows; multi-OS CI matrices and cloud VM orchestrations are deferred to Phase 5.

---

## 🚀 Setup & Installation

### Prerequisites:
- **Node.js**: Version `v20` or higher is required.
- **SQLite**: Runtime drivers are compiled automatically via `better-sqlite3`.

### Setup steps:
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy configuration environment variables template:
   ```bash
   cp .env.example .env
   ```
3. Edit `.env` and configure your credentials:
   - **`ANTHROPIC_API_KEY`**: Your Anthropic API Key (e.g. `sk-ant-xxx`). Required to authenticate and route requests.
   - **`JARVIS_DB_PATH`**: Database path (default: `memory-store/jarvis.db`).
   - **`JARVIS_MODEL`**: Target LLM model (default: `claude-sonnet-4-6`).
   - **`JARVIS_MAX_RETRIES`**: API backoff attempt limit (default: `3`).
   - **`JARVIS_POLL_INTERVAL_MS`**: Queue claim interval (default: `5000`).
   - **`JARVIS_STALE_TASK_TIMEOUT_MS`**: Heartbeat timeout crash recovery limit (default: `300000`).
   - **`JARVIS_LOG_LEVEL`**: Logging detail level (default: `info`).
   - **`JARVIS_PROJECT_ROOT`**: Project-root directory for path-scoped filesystem and git connectors (default: `process.cwd()`).
   - **`JARVIS_APPROVAL_TIMEOUT_MS`**: Timeout in milliseconds for interactive terminal permission prompts (default: `30000`).
   - **`JARVIS_VECTOR_STORE_PATH`**: File path to store semantic embedding vectors in SQLite (default: `memory-store/vectors.db`).
   - **`JARVIS_VECTOR_STORE_TYPE`**: Vector store implementation type (default: `sqlite-json-cosine`).
   - **`JARVIS_EMBEDDING_DIMENSIONS`**: Dimensions for local n-gram embedding vectors (default: `384`).
   - **`JARVIS_MEMORY_MAX_ENTRIES`**: Memory manager maximum retention capacity limit (default: `1000`).

---

## ⚙️ Running Jarvis OS

### Running the Daemon
The background task daemon orchestrates recoveries and executes queued items.

- **To run directly in development mode (TypeScript compilation on the fly)**:
  ```bash
  npm start
  ```
- **To compile to JavaScript and run**:
  ```bash
  npm run build
  node dist/core/src/index.js
  ```

### Stopping the Daemon
- **SIGINT / SIGTERM**: Press `Ctrl+C` in the running terminal. The daemon will complete any active heartbeats and cleanly close database handles.
- **Emergency stop**: Run `jarvis stop` (see below) to write a halt signal file. The daemon will instantly stop claiming new tasks.

---

## 🛠️ CLI Reference

The CLI tool allows you to interact with the database queue and audit logs. You can invoke it via:
```bash
npx tsx cli/index.ts <command>
```
Or when compiled:
```bash
node dist/cli/index.js <command>
```

### Commands:

#### 1. `submit`
Enqueues a task to the queue database.
```bash
node dist/cli/index.js submit "Write standard logging system code" --priority 2 --target-path "./logs.ts" --max-retries 1
```
* **Flags**:
  - `--priority <n>`: Priority integer (higher runs first).
  - `--depends-on <taskId>`: Prerequisite task ID.
  - `--target-path <path>`: Path to write the agent code output.
  - `--max-retries <n>`: Reschedule retry limit (default: 3).
  - `--id <id>`: Idempotency token to avoid duplicate submissions.

#### 2. `status`
Displays total status counters followed by the detailed task queue.
```bash
node dist/cli/index.js status
```

#### 3. `logs`
Prints chronological audit log entries.
```bash
node dist/cli/index.js logs --limit 10
```

#### 4. `stop`
Triggers an emergency halt across the system.
```bash
node dist/cli/index.js stop
```

#### 5. `help`
Prints CLI commands and flags documentation.
```bash
node dist/cli/index.js help
```

---

## 🛡️ The Permission Gatekeeper & Role-Based Policy Engine

Jarvis implements a "deny-by-default" security posture. Every mutating filesystem or git operation is routed through the `PermissionGatekeeper`.

### 1. Guarded Actions Taxonomy
In `core/src/permissions/policy.ts`, the `GuardedAction` union classifies all controlled operations:
```typescript
export type GuardedAction =
  | 'file-read'
  | 'file-write'
  | 'file-delete'
  | 'git-operation'
  | 'git-force-push'
  | 'git-history-rewrite'
  | 'destructive'
  | 'memory-read'
  | 'memory-write';
```

### 2. Role-Based PolicyMap Definitions (`DEFAULT_AGENT_POLICIES`)
Each agent persona has an explicit allow-list of permissions defined in `DEFAULT_AGENT_POLICIES`:
- **`software-engineer`**:
  - `allowedActions`: `['file-read', 'file-write', 'file-delete', 'git-operation', 'git-force-push', 'git-history-rewrite', 'destructive', 'memory-read', 'memory-write']`
  - `autoApprovedActions`: `['file-read', 'memory-read']`
- **`researcher`**:
  - `allowedActions`: `['file-read', 'memory-read', 'memory-write']`
  - `autoApprovedActions`: `['file-read', 'memory-read']`

**How to extend role policies for new agents**:
To add a new agent persona, define an entry in `DEFAULT_AGENT_POLICIES` within `core/src/permissions/policy.ts`:
```typescript
export const DEFAULT_AGENT_POLICIES: Record<string, AgentPolicy> = {
  // Existing roles...
  'qa-tester': {
    allowedActions: ['file-read', 'git-operation'],
    autoApprovedActions: ['file-read'],
  },
};
```

### 3. Two-Step Authorization Flow (`gatekeeper.authorize`)
When an agent or connector requests an action via `gatekeeper.authorize({ actor, action, params })`, the Gatekeeper evaluates:
1. **Role Check (Step 1)**: Checks if `action` is present in the actor's `allowedActions`. If not, it rejects immediately (`denied — not-permitted`) without prompting the user.
2. **Policy Pre-Approval & Prompting (Step 2)**:
   - If `action` is in `autoApprovedActions` (e.g. `file-read`), permission is granted automatically without interactive prompt.
   - If `action` is destructive (`git-force-push`, `git-history-rewrite`, `destructive`), the Gatekeeper routes to a **high-friction confirmation prompt**, requiring the user to type the exact challenge string (e.g. `"CONFIRM REWRITE HISTORY"` or `"CONFIRM FORCE PUSH"`).
   - For standard mutating actions (`file-write`, `file-delete`, `git-operation`), the Gatekeeper issues a standard interactive `(y/N)` prompt.

### 4. Security Gating for Memory Operations
In Phase 3, both memory reading and memory writing are classified as `GuardedAction` permissions:
* `'memory-read'`: Allowed and auto-approved for both the `software-engineer` and `researcher` roles, ensuring read operations record a non-blocking decision log in the immutable `AuditLog` for traceability.
* `'memory-write'`: Allowed for both `software-engineer` and `researcher` roles, requiring human approval unless run in non-interactive/automated paths.

---

## 🧠 Semantic Memory & Long-Term Context Retention

Jarvis features an integrated semantic memory subsystem managed by `MemoryManager`. It allows agents to retain context, search prior logs, and build long-term memory across sessions.

### Custom SQLite JSON Cosine Vector Store
Instead of external memory services or dynamic libraries (like compiled C++ `sqlite-vss`), Jarvis uses a custom SQLite-backed vector store (type: `sqlite-json-cosine`).
* **Embeddings**: deterministic character 3-gram and 4-gram TF-IDF hashing vectors generated via `LocalEmbeddingProvider`.
* **Cosine Similarity**: Computed in TS/JS application memory over JSON float arrays stored in `vectors.db`.
* **Trade-off**: High portability (zero-friction compilation across all platforms) but requires a linear-scan $O(N)$ query check which is suitable for developer workspace volumes (up to thousands of entries).

### FIFO Retention Policy
To prevent memory database bloat, a First-In, First-Out (FIFO) eviction limit is enforced via the `JARVIS_MEMORY_MAX_ENTRIES` configuration:
* If the number of entries exceeds the limit, the oldest memories are deleted.
* Eviction sorting uses `timestamp ASC, rowid ASC` to resolve same-millisecond insertions deterministically.

### Pattern-Based Secrets Redaction
Before a memory is stored, the text is scanned for sensitive key shapes (AWS keys, Claude/OpenAI keys, hex/base64 tokens).
* If matched, the memory store rejects the write immediately with `RedactionValidationError`.
* A denied decision log is recorded in `AuditLog` for security tracing without writing the sensitive string.
* **Warning**: This pattern check is regex-based and has coverage gaps; it should not replace dedicated credential scanners.

### Agent Memory Query Example
Below is an example showing how agents query and store memories in their task processing pipelines:

```typescript
import { deriveProjectTag } from '../shared/Agent.js';

// 1. Recall prior context using a derived project/context tag
const tag = deriveProjectTag(input);
const memories = await this.memoryManager.query(input.description, { tag, limit: 5 }, this.name);

let recalledContext = '';
if (memories.length > 0) {
  recalledContext = memories.map((m, idx) => `Memory ${idx + 1}: ${m.content}`).join('\n');
}

// 2. Pass enriched description to the Model Router
const modelResponse = await this.modelRouter.route('coding', {
  description: recalledContext ? `${input.description}\n\n[RECALLED PRIOR CONTEXT]:\n${recalledContext}` : input.description,
  fileContext: input.fileContext,
});

// 3. Store task completion memory upon successful execution
const completionSummary = `Successfully completed: ${input.description}. Summary: ${modelResponse.text}`;
await this.memoryManager.store({
  content: completionSummary,
  sourceAgent: this.name,
  sourceTaskId: input.taskId,
  tag,
});
```

---

## 🧪 Testing & CI Verification

Jarvis employs **Vitest** for unit, integration, and E2E pipeline verification. The repository maintains **131 tests across 22 test files**, covering queue scheduling, role-based Gating, memory persistence across restarts, and cross-agent shared project recalls.

### Running CI Checks Locally Before Pushing
Before pushing commits or submitting pull requests, developers must run the exact verification pipeline executed by GitHub Actions:

1. **Install clean dependencies**:
   ```bash
   npm ci
   ```
2. **Typecheck (TypeScript Compiler Verification)**:
   ```bash
   npx tsc --noEmit
   ```
3. **Run Full Test Suite**:
   ```bash
   npm test
   ```

> [!NOTE]
> **Why linting is skipped in CI**: No `lint` script is defined in `package.json`. Per project standards, code correctness is validated via strict TypeScript compilation (`npx tsc --noEmit`) and Vitest assertions. Rather than inventing an unconfigured linter setup from scratch, the CI pipeline skips linting.

---

## ⚠️ Known Limitations & Phase 2 Transition Notes

1. **Process-Wide Config Cache**: Configurations are cached process-wide inside `config.ts` after the first call. Tests or scripts updating environment variables mid-execution must call `clearConfigCache()` to reload settings.
2. **Non-Interactive Stdin Limitations**: In background tasks or CI/CD pipelines, stdin cannot block for input. Gated filesystem writes will default to `false` (denied) in these environments.
3. **Double Polling Interval Ticks**: The Orchestrator re-arms its timeout loop after completing a cycle. If a cycle is skipped due to in-flight processing, a secondary wait tick is queued. This is harmless but adds minor polling redundancy.
4. **Outcome Log Matching**: Audit outcome rows link to decision rows via a generated `correlation_id` rather than hard foreign keys. This design ensures outcome logs remain decoupled from database write-locking triggers on the audit table.
5. **Linting and Formatters**: Code checks are performed strictly via the TypeScript compiler (`npx tsc --noEmit`). Project-wide ESLint and Prettier configurations are deferred.
6. **Claude Request Timeout**: Request timeout limits on Claude API connections are deferred until a production latency requirement arises.
7. **Local-Only Researcher Scope**: The Researcher Agent operates strictly on local filesystem context via `FilesystemConnector`; external web browsing or HTTP fetching is deferred to Phase 5.
