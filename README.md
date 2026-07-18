# Legacy's Helios - Jarvis OS Kernel (Phase 1)

> **A modular, autonomous AI Operating System designed for software engineering, automation, scientific research, and deep productivity.**

---

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

---

## 👁️ Project Scope & Boundaries

### What Jarvis Phase 1 IS:
**Jarvis Phase 1** is the core operational kernel of the AI Operating System, establishing:
1. **The Task Queue**: A relational DAG scheduler running on SQLite (utilizing better-sqlite3) with WAL journaling, immutable audit logs via database triggers, priority sorting, retry management, and dependency gating.
2. **The Model Router**: A routing facade dispatcher with exponential backoff retries connecting to the Anthropic messages API.
3. **The Worker Agent**: The `SoftwareEngineerAgent` worker executing LLM-driven coding requirements, writing file outputs to disk.
4. **The Permission Gatekeeper**: A human-in-the-loop validation barrier intercepting filesystem mutations, recording decisions and outcome records in the audit database.
5. **The Daemon & CLI**: An asynchronous poll loop orchestrator daemon, and a 5-command CLI interface.

### What Jarvis Phase 1 is NOT (Deferred to Later Phases):
- **No Voice Interface**: Audio processing is deferred.
- **No Browser Automation**: Web browsing agents are not supported in Phase 1.
- **No Additional Agent Personas**: Only the Software Engineer agent is implemented; researchers or reviewers are deferred.
- **No Vector Memory**: Multi-layered long term semantic memory is deferred.
- **No Cross-Process Message Brokers**: Event routing is strictly in-process; Redis/NATS pub-sub is deferred.
- **No Electron/Graphical GUI**: The system runs strictly in TTY terminal environments.
- **No Cloud Deployment**: Running containers or remote cluster orchestrations is deferred.

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
* **Output Example**:
  ```
  pending=2  in-progress=0  completed=0  failed=0  blocked=0

  [PENDING] id=task-log priority=2 retries=0/3 - Write standard logging system code
  ```

#### 3. `logs`
Prints the chronological audit log entries.
```bash
node dist/cli/index.js logs --limit 10
```
* **Flags**:
  - `--limit <n>`: Row count limit (default: 20).
* **Output Example**:
  ```
  [OUTCOME] [2026-07-17T18:38:16.801Z] actor=cli action=emergency-stop outcome=stop signal written
  [DECISION] [2026-07-17T18:38:16.792Z] actor=cli action=emergency-stop status=n-a approver=user params={"stopSignalPath":"memory-store\\EMERGENCY_STOP"}
  ```

#### 4. `stop`
Triggers an emergency halt across the system.
```bash
node dist/cli/index.js stop
```

#### 5. `help`
Prints the CLI commands and flags documentation.
```bash
node dist/cli/index.js help
```

---

## 🛡️ The Permission Gatekeeper

The **Permission Gatekeeper** blocks filesystem mutation requests (`file-write` and `file-delete`) until human approval is obtained.

1. **Interactive Prompt**: If the command is run in an interactive terminal (process.stdin is a TTY), you will see:
   ```
   ========================================
   PERMISSION REQUESTED
   Actor:  software-engineer
   Action: file-write
   Path:   C:\workspace\file.ts
   ========================================
   Approve? (y/N): 
   ```
   Typing exactly `y` (case-insensitive) grants permission. Any other response denies it.
2. **Non-Interactive Fallback**: If standard input is not a TTY (e.g. background runners, pipelines, Docker containers), the prompt resolves to `false` (deny-by-default) instantly to prevent hanging execution.

---

## 🧪 Testing

Jarvis runs its test suite using Vitest.
```bash
npm test
```
This runs 64 unit, integration, and subprocess child-process E2E pipeline tests.

---

## ⚠️ Known Limitations & Phase 2 Transition Notes

1. **Process-Wide Config Cache**: Configurations are cached process-wide inside `config.ts` after the first call. Tests or scripts updating environment variables mid-execution must call `clearConfigCache()` to reload settings.
2. **Non-Interactive Stdin Limitations**: In background tasks or CI/CD pipelines, stdin cannot block for input. Gated filesystem writes will default to `false` (denied) in these environments.
3. **Double Polling Interval Ticks**: The Orchestrator re-arms its timeout loop after completing a cycle. If a cycle is skipped due to in-flight processing, a secondary wait tick is queued. This is harmless but adds minor polling redundancy.
4. **Outcome log matching**: Audit outcome rows link to decision rows via a generated `correlation_id` rather than hard foreign keys. This design ensures outcome logs remain decoupled from database write-locking triggers on the audit table.
5. **Linting and Formatters**: Code checks are performed strictly via the TypeScript compiler (`npx tsc --noEmit`). Project-wide ESLint and Prettier configurations are deferred to Phase 2.
6. **Claude request timeout**: Request timeout limits on Claude API connections are deferred until a production latency requirement arises.
