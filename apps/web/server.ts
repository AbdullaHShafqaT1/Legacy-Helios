import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { OllamaConnector } from '../../connectors/ollama/OllamaConnector.js';
import { openCliContext, CliContext } from '../../core/src/bootstrap.js';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.JARVIS_WEB_PORT ?? '3000', 10);
const MODEL = process.env.JARVIS_OLLAMA_MODEL ?? 'llava:latest';
const BASE_URL = process.env.JARVIS_OLLAMA_BASE_URL ?? 'http://localhost:11434';
const DASHBOARD_PORT = process.env.JARVIS_DASHBOARD_PORT ?? '8086';

const logger = pino({ level: 'info' });

let cliCtx: CliContext | null = null;
try {
  cliCtx = openCliContext('jarvis-web');
} catch (err: any) {
  logger.warn({ err: err.message }, 'Failed to initialize database/queue context in web server');
}

const ollama = new OllamaConnector({
  model: MODEL,
  baseUrl: BASE_URL,
  maxRetries: 2,
  timeoutMs: 120_000,
  logger: pino({ level: 'warn' }),
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ico': 'image/x-icon',
};

const SYSTEM_PROMPT =
  'You are Jarvis, an advanced AI assistant with a calm, intelligent tone. ' +
  'Keep spoken responses concise — 2-3 sentences maximum. ' +
  'For text responses you may be more detailed when appropriate.';

// ─── HTTP static file server ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const safePath = (req.url === '/' ? '/index.html' : req.url!).replace(/\.\./g, '');
  const filePath = path.join(__dirname, safePath);
  const ext = path.extname(filePath);
  const mime = MIME[ext] ?? 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// Helper to query daemon autonomous mode status
async function getDaemonAutonomousMode(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: parseInt(DASHBOARD_PORT, 10),
      path: '/api/status',
      method: 'GET',
      timeout: 1000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(Boolean(parsed.autonomousMode));
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function formatAuditAction(action: string, paramsJson: string | null): string | null {
  if (!paramsJson) return null;
  try {
    const params = JSON.parse(paramsJson);
    if (action === 'desktop-keyboard') {
      if (params.action === 'hotkey') {
        const keys = params.keys || params.key;
        return `Action: Executing hotkey (${Array.isArray(keys) ? keys.join('+') : keys})`;
      }
      if (params.action === 'type') {
        const textPreview = params.text ? (params.text.length > 30 ? params.text.slice(0, 30) + '...' : params.text) : '';
        return `Action: Typing "${textPreview}"`;
      }
      if (params.action === 'press') {
        return `Action: Pressing key [${params.key}]`;
      }
      if (params.action === 'open_tab') {
        return `Action: Opening new browser tab`;
      }
    } else if (action === 'desktop-mouse') {
      if (params.action === 'click') {
        return `Action: Clicking mouse at (${params.x}, ${params.y})`;
      }
      if (params.action === 'move') {
        return `Action: Moving mouse to (${params.x}, ${params.y})`;
      }
      if (params.action === 'scroll') {
        return `Action: Scrolling (${params.amount})`;
      }
    } else if (action === 'vision-read') {
      return `Action: Observing screen display...`;
    }
  } catch {}
  return null;
}

// ─── WebSocket chat handler ───────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (ws: WebSocket) => {
  logger.info('Browser client connected');
  const history: { role: string; content: string }[] = [];
  let isAutonomousMode = false;

  const send = (payload: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  // Sync autonomous mode with running daemon on connection
  getDaemonAutonomousMode().then((auto) => {
    isAutonomousMode = auto;
    send({ type: 'mode_ack', autonomous: auto, success: true });
  });

  ws.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'set_mode') {
      isAutonomousMode = Boolean(msg.autonomous);
      logger.info({ isAutonomousMode }, 'Received set_mode request from client');

      try {
        const postData = JSON.stringify({ autonomous: isAutonomousMode });
        const request = http.request({
          hostname: '127.0.0.1',
          port: parseInt(DASHBOARD_PORT, 10),
          path: '/api/autonomous-mode',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            logger.info({ statusCode: res.statusCode }, 'Autonomous mode forwarded to daemon');
            send({ type: 'mode_ack', autonomous: isAutonomousMode, success: res.statusCode === 200 });
          });
        });

        request.on('error', (err) => {
          logger.warn({ err: err.message }, 'Daemon not reachable on dashboardPort');
          send({ type: 'mode_ack', autonomous: isAutonomousMode, success: false, error: err.message });
        });

        request.write(postData);
        request.end();
      } catch (err: any) {
        logger.error({ err }, 'Failed to dispatch mode update');
        send({ type: 'mode_ack', autonomous: isAutonomousMode, success: false, error: err.message });
      }
      return;
    }

    if (msg.type !== 'message' || !msg.text?.trim()) return;

    const userText = msg.text.trim();

    // 1. Determine if this is an actionable command or conversational chat
    const isExplicitlyTagged = /^[#\[](desktop|coding|research|review|pm|browser|terminal)/i.test(userText);
    const hasDesktopKeywords = /(open|new)\s+tab|active\s+browser|youtube|desktop|screen|click|type|scroll|mouse|hotkey|browser/i.test(userText);
    const isActionVerb = /^(open|navigate|go to|search|click|type|press|run|create|write|start|launch|close|find|play)\b/i.test(userText);

    const isActionable = Boolean(cliCtx) && (isExplicitlyTagged || isAutonomousMode || hasDesktopKeywords || isActionVerb);

    if (!isActionable) {
      // Standard Conversational Completion
      const turns = history
        .map(h => `${h.role === 'user' ? 'User' : 'Jarvis'}: ${h.content}`)
        .join('\n');
      const prompt = `${SYSTEM_PROMPT}\n\n${turns}\nUser: ${userText}\nJarvis:`;

      send({ type: 'state', state: 'thinking' });

      try {
        const result = await ollama.invoke({ description: prompt });
        const reply = result.text.trim();

        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: reply });

        send({ type: 'reply', text: reply });
      } catch (err: any) {
        logger.error({ err }, 'Ollama call failed');
        send({ type: 'error', text: `Error: ${err.message}` });
      } finally {
        send({ type: 'state', state: 'idle' });
      }
      return;
    }

    // 2. Actionable command: Enqueue into SQLite TaskQueue
    send({ type: 'state', state: 'thinking' });

    let targetAgent: string | undefined;
    if (isExplicitlyTagged) {
      const match = userText.match(/^[#\[]([a-zA-Z0-9_-]+)[\]]?/);
      if (match) targetAgent = match[1];
    } else if (hasDesktopKeywords || isAutonomousMode) {
      targetAgent = 'desktop-operator';
    }

    try {
      if (!cliCtx) {
        throw new Error('TaskQueue database context is not initialized.');
      }

      // Check max audit ID before enqueuing so we only stream new actions
      let lastAuditId = 0;
      try {
        const maxRow = cliCtx.db.prepare('SELECT MAX(id) as maxId FROM audit_log').get() as { maxId: number | null };
        lastAuditId = maxRow?.maxId ?? 0;
      } catch {}

      const task = cliCtx.queue.enqueue({
        description: userText,
        source: 'cli',
        fileContext: targetAgent ? { agent: targetAgent, target: targetAgent } : undefined,
      });

      send({
        type: 'system',
        text: `Task submitted to queue [ID: ${task.id.slice(0, 8)}] [Agent: ${targetAgent || 'auto'}] [Status: pending]`,
      });

      // 3. Monitor execution and stream progress to Web HUD
      let hasClaimed = false;
      const emittedActions = new Set<string>();
      const startTime = Date.now();
      const MAX_WAIT_MS = 180_000; // 3 minutes timeout

      const monitorInterval = setInterval(() => {
        try {
          if (!cliCtx) {
            clearInterval(monitorInterval);
            return;
          }

          const currentTask = cliCtx.queue.getById(task.id);
          if (!currentTask) {
            clearInterval(monitorInterval);
            send({ type: 'error', text: `Task ${task.id.slice(0, 8)} no longer found in queue.` });
            send({ type: 'state', state: 'idle' });
            return;
          }

          // Check if task transitioned to in-progress
          if (currentTask.status === 'in-progress' && !hasClaimed) {
            hasClaimed = true;
            send({
              type: 'system',
              text: `Task ${task.id.slice(0, 8)} claimed by orchestrator. Executing agent actions...`,
            });
          }

          // Poll audit log for new action events
          try {
            const auditRows = cliCtx.db.prepare(`
              SELECT id, actor, action, params_json, outcome FROM audit_log
              WHERE id > ? AND (actor = 'desktop-operator' OR actor = 'terminal-operator' OR actor = 'browser-operator')
              ORDER BY id ASC
            `).all(lastAuditId) as { id: number; actor: string; action: string; params_json: string | null; outcome: string | null }[];

            for (const row of auditRows) {
              lastAuditId = Math.max(lastAuditId, row.id);
              const auditKey = `${row.id}-${row.action}-${row.params_json}`;
              if (!emittedActions.has(auditKey)) {
                emittedActions.add(auditKey);
                const progressText = formatAuditAction(row.action, row.params_json);
                if (progressText) {
                  send({ type: 'progress', text: progressText });
                }
              }
            }
          } catch (e) {
            // Ignore audit log read hiccups
          }

          // Check for task completion
          if (currentTask.status === 'completed') {
            clearInterval(monitorInterval);
            let replyText = `Task ${task.id.slice(0, 8)} completed successfully.`;
            if (currentTask.result_json) {
              try {
                const parsed = JSON.parse(currentTask.result_json);
                if (parsed.explanation) {
                  replyText = parsed.explanation;
                } else if (typeof parsed === 'string') {
                  replyText = parsed;
                }
              } catch {
                replyText = currentTask.result_json;
              }
            }
            send({ type: 'reply', text: replyText });
            send({ type: 'state', state: 'idle' });
            return;
          }

          // Check for task failure
          if (currentTask.status === 'failed') {
            clearInterval(monitorInterval);
            send({
              type: 'error',
              text: `Task failed: ${currentTask.error || 'Execution encountered an unrecoverable error.'}`,
            });
            send({ type: 'state', state: 'idle' });
            return;
          }

          // Check for timeout
          if (Date.now() - startTime > MAX_WAIT_MS) {
            clearInterval(monitorInterval);
            send({ type: 'error', text: `Task ${task.id.slice(0, 8)} execution timed out.` });
            send({ type: 'state', state: 'idle' });
          }
        } catch (pollErr: any) {
          logger.error({ pollErr }, 'Error during task polling');
        }
      }, 500);

      ws.on('close', () => clearInterval(monitorInterval));
    } catch (enqueueErr: any) {
      logger.error({ enqueueErr }, 'Failed to enqueue actionable command');
      send({ type: 'error', text: `Failed to enqueue task: ${enqueueErr.message}` });
      send({ type: 'state', state: 'idle' });
    }
  });

  ws.on('close', () => logger.info('Browser client disconnected'));
  ws.on('error', (err) => logger.error({ err }, 'WebSocket error'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🤖  JARVIS WEB UI ONLINE               ║
║   Open  →  http://localhost:${PORT}          ║
║   Model →  ${MODEL.padEnd(29)}║
╚══════════════════════════════════════════╝
`);
});
