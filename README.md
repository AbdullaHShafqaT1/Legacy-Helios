# Legacy's Helios - Jarvis OS Kernel (Phases 1–13 Complete)

> **A modular, autonomous AI Operating System designed for software engineering, automation, scientific research, and deep productivity.**

---

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)
[![CI Pipeline](https://github.com/AbdullaHShafqaT1/Legacy-Helios/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)

---

## 👁️ Project Scope & Boundaries

### What Jarvis Phases 1–6 ARE:
**Jarvis Phases 1–6** establish the core operational kernel, permission security layer, local filesystem/git connectors, semantic memory retention, specialized worker agents, browser automation, terminal operation, and cron-based scheduling:
1. **The Task Queue (`TaskQueue`)**: A relational DAG scheduler running on SQLite (utilizing `better-sqlite3`) with WAL journaling, immutable audit logs via database triggers, priority sorting, retry management, dependency gating, deterministic same-millisecond FIFO task ordering via monotonic `sequence_id`, and a full cron-based scheduler supporting missed-run policies (skip/catch-up).
2. **The Model Router (`ModelRouter`)**: A routing facade dispatcher with exponential backoff retries connecting to the Anthropic messages API, supporting `"coding"`, `"reasoning"`, and `"research"` task types, with configurable request timeouts.
3. **The Worker Agents**:
   - **`SoftwareEngineerAgent`**: Executes LLM-driven coding requirements, writing and modifying file outputs on disk under strict Permission Gatekeeper gating. Appends recalled semantic memories into the model context, and stores task summaries upon completion.
   - **`ResearcherAgent`**: Evaluates natural-language queries and scoped filesystem context, returning structured research summaries (`summary`, `citations`, `confidence`, `caveats`). Operates with read-only permissions and never attempts mutations. Integrates project-level semantic recall and completion recording.
4. **The Permission Gatekeeper (`PermissionGatekeeper`)**: A 2-step role-based and policy-driven validation barrier intercepting filesystem, git, and memory operations, recording decisions and outcome records in the audit database.
5. **The Connectors**:
   - **`FilesystemConnector`**: Provides project-root scoped read/write/delete access (`listDir`, `readFile`, `writeFile`, `deleteFile`) with strict path-traversal protection and audit logging.
   - **`GitConnector`**: Provides project-root scoped Git operations (`status`, `log`, `diff`, `commit`, `push`, `forcePush`, `resetHard`) with error classification and high-friction confirmation gating for destructive operations.
   - **`BrowserConnector`**: Playwright-backed headless browser automation with risk-tiered gating (`browser-read` / `browser-write` / `browser-admin`), local-URL blocking, per-domain allowlist, and full audit logging.
   - **`TerminalConnector`**: Path-scoped shell command execution with configurable timeout, exact-match and wildcard allowlist pre-approval for safe commands, high-friction gating for unlisted commands, process-tree kill on emergency stop, and stdout/stderr secrets redaction.
6. **The Daemon & CLI**: An asynchronous poll loop orchestrator daemon (using `AsyncLocalStorage` for strict context tracking and unattended approval queues) and a 7-command CLI interface (`submit`, `status`, `logs`, `stop`, `help`, `approve`, `briefing`).
7. **Semantic Memory Manager (`MemoryManager`)**: A local-first semantic memory retrieval pipeline using `SqliteVectorStore` (type `'sqlite-json-cosine'`) to store JSON-serialized embedding float arrays, supporting context recall (via character n-gram TF-IDF embeddings) and automated write integrations on task completion for both Software Engineer and Researcher agents, limited by FIFO eviction policy.

### What Jarvis Phases 1–6 are NOT (Deferred to Phase 7):
- **No Voice Interface**: Audio processing is deferred.
- **No Additional Agent Personas**: Review and QA agent personas beyond the current six are deferred.
- **No External / Dynamic Cloud Vector Database**: ChromaDB, Pinecone, or Milvus are excluded; memory relies strictly on a local-first SQLite file vector database (type `'sqlite-json-cosine'`).
- **No Cross-Process Message Brokers**: Event routing is strictly in-process; Redis/NATS pub-sub is deferred.
- **No Electron/Graphical GUI**: The system runs strictly in TTY terminal environments.
- **No Linux/macOS CI Matrix**: Developed and verified locally on Windows; however, multi-OS CI matrices testing Ubuntu and macOS are fully enabled.

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
   - **`JARVIS_BROWSER_HEADLESS`**: Run browser automation in headless mode (default: `true`).
   - **`JARVIS_BROWSER_LOCAL_ALLOWLIST`**: Comma-separated local hostnames the browser may access without admin gating (default: `localhost,127.0.0.1`).
   - **`JARVIS_TERMINAL_ALLOWLIST`**: Comma-separated commands pre-approved for terminal execution without prompting (default: `echo,ls,pwd,cat,git,npm,npx`).
   - **`JARVIS_TERMINAL_TIMEOUT_MS`**: Maximum execution time in milliseconds for a terminal command before forced kill (default: `30000`).
  - **`JARVIS_WAKE_WORD_ENGINE`**: Selects the active wake-word engine. Options: `'openwakeword'`, `'porcupine'`, `'custom-energy'` (default: `'openwakeword'`).
  - **`JARVIS_PORCUPINE_ACCESS_KEY`**: AccessKey required if using the `'porcupine'` wake-word engine.
  - **`JARVIS_PERIODIC_CAPTURE_INTERVAL_MS`**: Time interval in milliseconds between background screenshot captures (default: `10000`).
  - **`JARVIS_PERIODIC_CAPTURE_RETENTION_MAX`**: Maximum number of periodic screenshot files to retain on disk in FIFO manner (default: `15`).
  - **`JARVIS_SEARCH_PROVIDER`**: Outbound search engine API provider. Options: `'tavily'`, `'duckduckgo'` (default: `'duckduckgo'`).
  - **`JARVIS_TAVILY_API_KEY`**: Developer API key required if using `'tavily'` search provider.
  - **`JARVIS_SEARCH_RATE_LIMIT_COUNT`**: Maximum queries allowed in the rate limit window (default: `10`).
  - **`JARVIS_SEARCH_RATE_LIMIT_WINDOW_MS`**: Time window in milliseconds for enforcing search rate limits (default: `60000`).
  - **`JARVIS_DASHBOARD_PORT`**: Port number for serving the local status web dashboard page and WebSocket stream (default: `8086`).
  - **`JARVIS_REDACTION_ENTROPY_THRESHOLD`**: Floating-point threshold for character-level Shannon entropy token masking pass (default: `3.7`).

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
  | 'memory-write'
  | 'browser-read'
  | 'browser-write'
  | 'browser-admin'
  | 'terminal-run';
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

## 🤝 Collaborative Multi-Agent Swarms & Message Routing (Phase 4)

Jarvis supports multi-agent swarms using a message router that enables agents to communicate in-process and coordinate tasks.

### 1. Agent-to-Agent Message Schema
All agent communication utilizes a structured `Message` type definition:
* **`id`**: Unique UUID string identifier.
* **`sender`**: Name of the originating agent (e.g. `'researcher'`).
* **`recipient`**: Name of the target agent (e.g. `'software-engineer'`).
* **`type`**: String message type identifier (e.g. `'review-request'`, `'review-result'`).
* **`payload`**: Dynamic object context payload.
* **`correlationId`**: ID of the request message when sending a reply.
* **`actingOnBehalfOf`**: Identifies delegation contexts.
* **`timestamp`**: ISO timestamp.
* **`hops`**: Array of agent names that forwarded the message (used for loop detection).

### 2. How to Add a New Message Type
1. Define the message payload structure and register type keys if appropriate.
2. In the target agent's `receiveMessage(message: AgentMessage): Promise<AgentMessage | null>` handler, add a case matching `message.type`:
   ```typescript
   if (message.type === 'my-new-message-type') {
     // process message.payload
     return {
       id: crypto.randomUUID(),
       sender: this.name,
       recipient: message.sender,
       type: 'my-response-type',
       payload: { ... },
       correlationId: message.id,
       timestamp: new Date().toISOString()
     };
   }
   ```
3. Route the message via `messageRouter.send()` or `messageRouter.sendAndReceive()`.

### 3. Kanban Schema Relation to Task Queue
The Kanban boards data model tracks the lifecycle state of tasks enqueued in the `tasks` table:
* Columns map task progression: `Todo` -> `In Progress` -> `Review` -> `Done`.
* Tasks are linked to cards via the `task_id` column.
* Card movements are driven by EventBus queue listeners (`task:created`, `task:started`, `task:completed`, `task:failed`) and agent-to-agent messaging outcomes (such as review rejections).
* **Security restriction**: Database mutations to the Kanban tables require the `'kanban-write'` action, which is permitted exclusively for the `project-manager` agent role.

### 4. Delegated Gating & Prevention of Privilege Escalation
When an agent performs an action on behalf of another agent (e.g. Researcher requests Software Engineer to write a file), the request is gated by the Gatekeeper:
* The Gatekeeper evaluates permissions strictly using the allow-list of the **ACTING** agent (`software-engineer`), never the sender (`researcher`).
* Privilege escalation is impossible since permissions do not union. If a Software Engineer asks a Researcher to write a file, the action is blocked because the acting agent (`researcher`) lacks `'file-write'` permission.
* The Audit Log captures both agents: `actor` records the acting agent (`software-engineer`), and `params.actingOnBehalfOf` records the sender (`researcher`).

**Example Audit Record for Delegated Write:**
* `actor`: `'software-engineer'`
* `action`: `'file-write'`
  - `approval_status`: `'granted'`
  - `params_json`: `{"path":"/workspace/code.js","bytes":42,"actingOnBehalfOf":"researcher"}`

## 🎙️ Voice Interaction & Gated Security (Phase 8)

Jarvis features a fully local-first, offline voice subsystem managed by `VoiceManager` and the continuous listening command `jarvis listen`.

### Local Setup & Prerequisites
To run the offline local speech stack:
1. **Python packages**: Install speech engine requirements on the system Python:
   ```bash
   pip install -r requirements-speech.txt
   ```
2. **Download Models**: Run the model downloader to pre-cache openWakeWord ONNX files and the Whisper tiny weights:
   ```bash
   python core/src/voice/engines/download_models.py
   ```

### 1. Advanced Speech Configuration Settings
The local speech engines behavior can be customized via the following variables in the `.env` configuration file:
* **`JARVIS_WAKE_WORD_MODEL_PATH`**: Specifies a custom ONNX wake word model path (default: empty string, loads bundled `'jarvis'` model).
* **`JARVIS_STT_MODEL_PATH`**: Configurable local directory path or model version/name of the Whisper model to load (default: `'tiny'`).
* **`JARVIS_AUDIO_INPUT_DEVICE`**: Custom microphone audio capture device name or index (default: empty string, maps to default OS microphone).
* **`JARVIS_AUDIO_OUTPUT_DEVICE`**: Custom speaker output device name or index (default: empty string, maps to default OS speaker).
* **`JARVIS_AUDIO_SAMPLE_RATE`**: Specifies the sample rate for audio processes (default: `16000`).
* **`JARVIS_CI_FALLBACK`**: Toggles tolerance logic on lightweight headless CI matrices lacking physical microphones or speakers (default: `false`). If `true`, the STT/wake word models will run on file-based fixtures where cached, and the TTS engine generates silent dummy files instead of crashing.

### 2. Wake Word & Speech-to-Text Engines
* **Wake Word**: Continuous local listening via OpenWakeWord loads `hey_jarvis_v0.1.onnx` using `onnxruntime` to scan microphone streams (mono 16kHz PCM).
* **STT**: Uses `openai-whisper` (tiny model) loaded locally to transcribe commands. Resampling and wav parsing are executed natively in python (using `scipy`), bypassing external `ffmpeg` executable dependencies.
* **Confidence Threshold**: Configured via `JARVIS_STT_CONFIDENCE_THRESHOLD` (default: `0.8`). If the Whisper model returns a confidence below this threshold, Jarvis states: *"I didn't quite catch that. Could you repeat?"* and discards the transcription to prevent incorrect action execution.

### 3. Text-to-Speech & Barge-In
* **TTS**: OS SAPI5 voice engine via `pyttsx3` is used to speak aloud or synthesize to WAV. To support cross-platform headless CI runners without audio drivers, the engine gracefully falls back to generating silent dummy WAV files and logging text instead of crashing if `JARVIS_CI_FALLBACK=true` is enabled.
* **Barge-In**: While TTS is speaking, if the user triggers the wake phrase, the TTS process is instantly terminated (`SIGKILL` to the playback subprocess tree), which clears SAPI5 audio buffers instantly to stop playback.
* **Daily Briefing**: Running `jarvis briefing --read-aloud` synthesizes the Claude daily summary and reads it aloud using the TTS pipeline.

### 4. Voice Gated Security Boundary (CRITICAL)
Voice input is **never** trusted to grant approvals. All tasks submitted via voice are tagged with `source: 'voice'`.
* **Forced Unattended Mode**: Any guarded action (e.g. `'file-write'`, `'git-operation'`, `'terminal-run'`) requested under a voice task is blocked from interactive CLI/TTY prompting. Instead, it is forced to enter the **Unattended Approval Queue** (`pending-approval` status).
* **CLI Approval Required**: The task halts and waits until an operator manually runs `jarvis approve <taskId>` via text CLI.

**The "Yes, Approved" Voice Bypass Verification (Objective 5):**
Even if a voice input command explicitly contains approval phrases (e.g., a synthesized audio file like `yes_approved.wav` containing `"yes, approved"` is fed into the transcriber), the permission gatekeeper identifies the task's origin is `source: 'voice'`. It immediately halts execution and forces the gated action to the `pending-approval` unattended queue, completely preventing voice-based approval privilege escalations.

**Example Gated Voice Flow:**
1. User says: *"Hey Jarvis"* -> triggers listening.
2. User says: *"Refactor the code in test.js"* -> STT transcribes.
3. Task is enqueued with `source: 'voice'`.
4. Software Engineer agent runs and attempts a `'file-write'` action on `test.js`.
5. Permission Gatekeeper detects `source: 'voice'`. It halts the task and records a `pending` decision in the `AuditLog`.
6. Jarvis states: *"Task requires manual CLI approval."*
7. User runs `jarvis approve <taskId>` via terminal.
8. Orchestrator resumes task and executes write.

### 5. Running Speech Fixture Tests Locally
Automated E2E speech tests run offline against pre-compiled audio WAV assets.
1. Generate test WAV fixtures:
   ```bash
   python core/test/fixtures/generate_fixtures.py
   ```
2. Execute the local speech stack unit and integration tests:
   ```bash
   npx vitest run core/test/voice.test.ts
   npx vitest run core/test/phase8-integration.test.ts
   ```

---

## 🧪 Testing & CI Verification

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
7. **Researcher Agent Web Scope**: The Researcher Agent can perform external web searches using `SearchConnector`. Outbound search queries are audited and rate-limited. Ingested content is sanitized via `redactSecrets` and encapsulated inside XML tags.
8. **Windows Process-Tree Kill**: On Windows, `TerminalConnector.killAll()` uses `taskkill /pid <pid> /f /t` to terminate subprocess trees. On Unix, `SIGKILL` is used. Exit handlers remove entries from `activeProcesses` after termination — `killAll()` only marks them as killed.
9. **Browser Headless Mode**: `BrowserConnector` operates in headless mode by default (`JARVIS_BROWSER_HEADLESS=true`). Non-headless operation is configurable but untested.
10. **Real-Restart Test (Objective 2 Limitation):** True OS-level process boundary traversal restart testing (e.g., launching the Orchestrator daemon via `child_process`, halting it via `SIGKILL` while a task is mid-flight, respawning it, and asserting recovery) is not implemented. Task resumption is simulated in-process via child-process DB manipulation. Writing a full multi-process daemon harness is deferred.
11. **Low-Level Hook Registration Unverified**: Hook handler tests run `input_hook.ps1` in `TEST_MODE` to assert bitwise flag checks via direct stdin pointer structure construction. End-to-end event redirection and delivery registration via `SetWindowsHookEx` are not verified using actual physical user inputs due to automated test harness limits.
12. **Win32-Only Safety Override Scoping**: On non-Windows OSes, `OverrideHookConnector` starts in a mock bypass mode that sets the state to 'active' immediately. If desktop interaction is expanded to macOS/Linux, native unmanaged OS-level event listeners must be written to avoid safety bypasses.
13. **Parallel Test Runner Timeout Susceptibility**: Launching the entire test suite concurrently on restricted CI/CD nodes can saturate CPU/IO capacity, leading to timeouts in tests invoking external child processes. Tests should run sequentially or with concurrency limited to 2 workers.

---

## 🛡️ Phase 11 Security & Safety Integrations

### User-Override Safety Gate
Jarvis implements a low-level, OS-native global input hook (`WH_KEYBOARD_LL` and `WH_MOUSE_LL` on Windows via `user32.dll`) to instantly halt automated sequences if physical hardware input is detected during task execution.

- **Synthetic vs. Genuine Input Distinction**: The hook process inspects the unmanaged event structure flags:
  - **Keyboard**: If `(KBDLLHOOKSTRUCT.flags & 0x10) == 0` (no `LLKHF_INJECTED` flag), the event was generated by physical hardware.
  - **Mouse**: If `(MSLLHOOKSTRUCT.flags & 0x01) == 0` (no `LLMHF_INJECTED` flag), it is a genuine physical mouse event.
- **Sensitivity Thresholds**: 
  - To prevent minor physical vibrations or accidental bumps of the mouse from triggering spurious aborts, mouse movement triggers an override only if the cursor move delta exceeds `JARVIS_OVERRIDE_MOUSE_THRESHOLD` (default: `10` pixels).
  - Click events bypass the delta check and trigger immediately.
- **Fail-Closed Policy**: If the low-level hook fails to compile or install on startup, Jarvis defaults to a **fail-closed** posture, immediately locking and rejecting all subsequent desktop control tasks.

### Continuous Listening & Voice Stop
The continuous voice loop moves beyond push-to-talk to offer hands-free turn-taking:
- **Conversation turn-taking**: Once the wake word triggers, Jarvis listens for follow-up commands directly (without repeating the wake word). This session transitions back to wake-word-only mode after `10` seconds of inactivity.
- **Voice-Triggered Stop**: Spoken commands `"stop"` or `"cancel"` during active tasks immediately halt Jarvis and fire a `queue:emergency-stop` event.
- **Voice Approval Boundary**: Voice remains **categorically forbidden** from resolving Gatekeeper permissions. Spoken approval attempts will only queue the task into the unattended queue, requiring manual CLI or console-text verification to approve.


## 🔒 Phase 13 Integrations & Safety Boundaries

### Voice Hot-Switching & Hardening
- **Multiple Engines**: Support `'openwakeword'`, `'porcupine'`, and `'custom-energy'`. Hot-switching engines mid-session restarts the listener process cleanly.
- **Auto-Fallback**: If a secondary engine crashes on startup (e.g. missing API key), the system automatically rolls back to `'openwakeword'` and restarts listening.
- **Accuracy Benchmarking**: Developers can benchmark wake-word accuracy by running `jarvis voice benchmark` against audio fixtures under delta sensitivity parameters.

### Periodic Visual Capture
- **Gated Continuous Captures**: Continuous screenshot loops are gated under the `'vision-periodic-start'` permission action category. Once starting is approved, individual captures run pre-approved to avoid disruption.
- **Tray Toolkit Presence**: Active periodic capture status is displayed as `[Periodic Snapshots Active]` in the system tray tooltip and health monitor.
- **FIFO File Cleanup**: Screenshots are cleaned up automatically in a FIFO manner, capping folder storage size to a user-configured limit.
- **Local-First Routing**: Image analysis defaults to local Ollama (llava) to safeguard user privacy, while cloud endpoints remain available as overrides.

### Autonomous Web Research Egress
- **Audited Queries**: Search requests use `SearchConnector` gated under the `'web-search'` action, logged, and rate-limited system-wide.
- **Prompt-Injection GDI Guard**: All ingested external snippets are wrapped inside strict `<untrusted-web-content>` XML tags. System instructions warn the model to treat the content strictly as data, neutralizing attempts like "ignore previous instructions".
- **Source Citations**: Output summaries preserve exact search citation mappings (URLs/titles).


