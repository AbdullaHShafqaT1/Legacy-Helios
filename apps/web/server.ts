import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { OllamaConnector } from '../../connectors/ollama/OllamaConnector.js';
import { LMStudioConnector } from '../../connectors/lmstudio/LMStudioConnector.js';
import { GeminiConnector } from '../../connectors/gemini/GeminiConnector.js';
import { CustomUrlConnector } from '../../connectors/custom/CustomUrlConnector.js';
import { ModelRoute } from '../../core/src/router/modelRouter.js';
import { fetchOllamaModels, fetchLMStudioModels, validateExternalApiKey } from '../../core/src/router/modelProviderService.js';
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

let activeProvider = (process.env.JARVIS_MODEL_PROVIDER as string) || (process.env.GEMINI_API_KEY ? 'api_key' : 'ollama');
let activeApiKey = process.env.GEMINI_API_KEY || '';
let activeModel = (activeProvider === 'api_key' || activeProvider === 'gemini') ? 'gemini-3.6-flash' : MODEL;
let activeBaseUrl = BASE_URL;
let activeCustomUrl = process.env.JARVIS_CUSTOM_ENDPOINT_URL || '';

let activeConnector: ModelRoute;
if ((activeProvider === 'api_key' || activeProvider === 'gemini') && activeApiKey) {
  activeConnector = new GeminiConnector({
    apiKey: activeApiKey,
    model: activeModel || 'gemini-3.6-flash',
    maxRetries: 2,
    timeoutMs: 60_000,
    logger: pino({ level: 'warn' }),
  });
} else {
  activeConnector = new OllamaConnector({
    model: MODEL,
    baseUrl: BASE_URL,
    maxRetries: 2,
    timeoutMs: 120_000,
    logger: pino({ level: 'warn' }),
  });
}

function switchProvider(payload: {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  customUrl?: string;
}) {
  activeProvider = payload.provider;
  if (payload.model) activeModel = payload.model;
  if (payload.baseUrl) activeBaseUrl = payload.baseUrl;
  if (payload.apiKey) activeApiKey = payload.apiKey;
  if (payload.customUrl) activeCustomUrl = payload.customUrl;

  logger.info({ activeProvider, activeModel }, 'Switching active LLM provider in Web Server');

  if (activeProvider === 'ollama') {
    activeConnector = new OllamaConnector({
      model: activeModel || MODEL,
      baseUrl: activeBaseUrl || BASE_URL,
      maxRetries: 2,
      timeoutMs: 120_000,
      logger: pino({ level: 'warn' }),
    });
  } else if (activeProvider === 'lmstudio') {
    activeConnector = new LMStudioConnector({
      model: activeModel || 'local-model',
      baseUrl: activeBaseUrl || 'http://localhost:1234',
      maxRetries: 2,
      timeoutMs: 60_000,
      logger: pino({ level: 'warn' }),
    });
  } else if (activeProvider === 'api_key' || activeProvider === 'gemini') {
    activeConnector = new GeminiConnector({
      apiKey: activeApiKey,
      model: activeModel || 'gemini-3.6-flash',
      maxRetries: 2,
      timeoutMs: 60_000,
      logger: pino({ level: 'warn' }),
    });
  } else if (activeProvider === 'custom_url') {
    activeConnector = new CustomUrlConnector({
      endpointUrl: activeCustomUrl || 'http://localhost:8000/v1',
      model: activeModel || 'custom-model',
      timeoutMs: 60_000,
      logger: pino({ level: 'warn' }),
    });
  }

  // Forward provider change to core daemon if dashboard port is alive
  try {
    const postData = JSON.stringify(payload);
    const forwardReq = http.request({
      hostname: '127.0.0.1',
      port: parseInt(DASHBOARD_PORT, 10),
      path: '/api/models/set-provider',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 1000,
    });
    forwardReq.on('error', () => {});
    forwardReq.write(postData);
    forwardReq.end();
  } catch {}
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ico': 'image/x-icon',
};

const SYSTEM_PROMPT =
  'You are Jarvis, an advanced AI assistant with a calm, intelligent tone.\n' +
  'Keep spoken responses concise — 2-3 sentences maximum. For text responses you may be more detailed when appropriate.\n\n' +
  'Desktop & Cursor Automation Capabilities:\n' +
  'You have full access to a native OS-level, Per-Monitor DPI-aware mouse control execution engine and desktop automation layer:\n' +
  '- Native Cursor Primitives: You can move the cursor (instantaneous or smooth trajectory via cubic ease-out), fire physical single/double/right clicks with hardware dwell time, execute drag-and-drop actions, and scroll.\n' +
  '- Hardware DPI Awareness: The execution engine runs Per-Monitor DPI Aware v2, eliminating coordinate drift across display scalings (100%, 125%, 150%, 200%).\n' +
  '- Coordinate Resolution: Coordinates can be specified in physical screen pixels (X, Y) or normalized coordinates [0, 1000] / [0.0, 1.0], or bounding boxes [ymin, xmin, ymax, xmax], which automatically target the geometric center.\n' +
  '- Action Routing: Any requests to interact with the desktop, click elements, open apps, or control the cursor are delegated to the desktop-operator agent with safety gatekeeping and execution verification.';

// ─── HTTP server with API endpoints and static file serving ───────────────────
const httpServer = http.createServer((req, res) => {
  const reqUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  if (req.method === 'GET' && pathname === '/api/models/ollama') {
    const baseUrl = reqUrl.searchParams.get('baseUrl') || activeBaseUrl || BASE_URL;
    fetchOllamaModels(baseUrl).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [], provider: 'ollama', error: err.message }));
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/models/lmstudio') {
    const baseUrl = reqUrl.searchParams.get('baseUrl') || 'http://localhost:1234';
    fetchLMStudioModels(baseUrl).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [], provider: 'lmstudio', error: err.message }));
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/models/active') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      provider: activeProvider,
      model: activeModel,
      baseUrl: activeBaseUrl,
      customUrl: activeCustomUrl,
      apiKeySet: Boolean(activeApiKey),
    }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/models/validate-key') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const result = await validateExternalApiKey(payload.provider || 'gemini', payload.apiKey, payload.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/models/set-provider') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.provider) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'provider is required' }));
          return;
        }
        switchProvider(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          provider: activeProvider,
          model: activeModel,
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

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
      if (params.action === 'focus_window') {
        return `Action: Focusing window (${params.target_window || 'browser'})`;
      }
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
        return `Action: Gliding cursor and clicking at (${params.x}, ${params.y})`;
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

  // Populate initial history from persisted SQLite memory turns
  if (cliCtx?.db) {
    try {
      const recentRows = cliCtx.db.prepare(`
        SELECT content FROM memory_entries
        WHERE tag = 'chat-turn'
        ORDER BY timestamp ASC
        LIMIT 30
      `).all() as { content: string }[];
      for (const row of recentRows) {
        if (row.content.startsWith('User: ')) {
          history.push({ role: 'user', content: row.content.slice(6) });
        } else if (row.content.startsWith('Jarvis: ')) {
          history.push({ role: 'assistant', content: row.content.slice(8) });
        }
      }
    } catch (dbErr: any) {
      logger.warn({ err: dbErr.message }, 'Failed to load chat history from SQLite');
    }
  }

  const send = (payload: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  // Sync autonomous mode with running daemon on connection
  getDaemonAutonomousMode().then((auto) => {
    isAutonomousMode = auto;
    send({ type: 'mode_ack', autonomous: auto, success: true });
  });

  // Send current active model provider state to client
  send({
    type: 'provider_ack',
    provider: activeProvider,
    model: activeModel,
    baseUrl: activeBaseUrl,
    customUrl: activeCustomUrl,
    apiKeySet: Boolean(activeApiKey),
    success: true,
  });

  ws.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'set_provider') {
      try {
        switchProvider(msg);
        send({
          type: 'provider_ack',
          provider: activeProvider,
          model: activeModel,
          success: true,
        });
      } catch (err: any) {
        send({
          type: 'provider_ack',
          provider: activeProvider,
          model: activeModel,
          success: false,
          error: err.message,
        });
      }
      return;
    }

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

    // Persist incoming user turn to SQLite via MemoryManager
    if (cliCtx?.memoryManager) {
      cliCtx.memoryManager.store({
        content: `User: ${userText}`,
        sourceAgent: 'system',
        tag: 'chat-turn',
      }).catch(err => logger.warn({ err: err.message }, 'Failed to persist user turn to memory'));
    }

    // 1. Determine if this is an actionable command or conversational chat
    const isExplicitlyTagged = /^[#\[](desktop|coding|research|review|pm|browser|terminal)/i.test(userText);
    const hasDesktopKeywords = /(open|new)\s+tab|active\s+browser|youtube|desktop|screen|click|type|scroll|mouse|hotkey|browser/i.test(userText);
    const isActionVerb = /^(open|navigate|go to|search|click|type|press|run|create|write|start|launch|close|find|play)\b/i.test(userText);

    const isActionable = Boolean(cliCtx) && (isExplicitlyTagged || hasDesktopKeywords || isActionVerb);

    if (!isActionable) {
      // Query relevant semantic memories from VectorStore before LLM invocation
      let memoryContext = '';
      if (cliCtx?.memoryManager) {
        try {
          const memories = await cliCtx.memoryManager.query(userText, { limit: 3 }, 'system');
          if (memories.length > 0) {
            memoryContext = `\nRelevant Past Context:\n${memories.map(m => `- ${m.content}`).join('\n')}\n`;
          }
        } catch (memErr: any) {
          logger.warn({ err: memErr.message }, 'Failed to query semantic memories for chat prompt');
        }
      }

      // Standard Conversational Completion using dynamically active connector
      const turns = history
        .map(h => `${h.role === 'user' ? 'User' : 'Jarvis'}: ${h.content}`)
        .join('\n');
      const prompt = `${SYSTEM_PROMPT}${memoryContext}\n\n${turns}\nUser: ${userText}\nJarvis:`;

      send({ type: 'state', state: 'thinking' });

      try {
        const result = await activeConnector.invoke({ description: prompt });
        const reply = result.text.trim();

        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: reply });

        // Persist assistant reply to SQLite via MemoryManager
        if (cliCtx?.memoryManager) {
          cliCtx.memoryManager.store({
            content: `Jarvis: ${reply}`,
            sourceAgent: 'system',
            tag: 'chat-turn',
          }).catch(err => logger.warn({ err: err.message }, 'Failed to persist assistant turn to memory'));
        }

        send({ type: 'reply', text: reply });
      } catch (err: any) {
        logger.error({ err }, 'Active model call failed');
        send({ type: 'error', text: `Error (${activeProvider}): ${err.message}` });
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
    } else if (hasDesktopKeywords) {
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

      let hasEmittedVisionObservation = false;

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
              if (row.action === 'vision-read') {
                if (hasEmittedVisionObservation) continue;
                hasEmittedVisionObservation = true;
              }
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

            history.push({ role: 'user', content: userText });
            history.push({ role: 'assistant', content: replyText });

            if (cliCtx?.memoryManager) {
              cliCtx.memoryManager.store({
                content: `Jarvis: ${replyText}`,
                sourceAgent: 'system',
                tag: 'chat-turn',
              }).catch(err => logger.warn({ err: err.message }, 'Failed to persist task result to memory'));
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
