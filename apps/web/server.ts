import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { OllamaConnector } from '../../connectors/ollama/OllamaConnector.js';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT     = parseInt(process.env.JARVIS_WEB_PORT      ?? '3000',              10);
const MODEL    = process.env.JARVIS_OLLAMA_MODEL            ?? 'llava:latest';
const BASE_URL = process.env.JARVIS_OLLAMA_BASE_URL         ?? 'http://localhost:11434';

const logger = pino({ level: 'info' });

const ollama = new OllamaConnector({
  model:     MODEL,
  baseUrl:   BASE_URL,
  maxRetries: 2,
  timeoutMs: 120_000,
  logger:    pino({ level: 'warn' }),
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.ico':  'image/x-icon',
};

const SYSTEM_PROMPT =
  'You are Jarvis, an advanced AI assistant with a calm, intelligent tone. ' +
  'Keep spoken responses concise — 2-3 sentences maximum. ' +
  'For text responses you may be more detailed when appropriate.';

// ─── HTTP static file server ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const safePath = (req.url === '/' ? '/index.html' : req.url!).replace(/\.\./g, '');
  const filePath = path.join(__dirname, safePath);
  const ext      = path.extname(filePath);
  const mime     = MIME[ext] ?? 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ─── WebSocket chat handler ───────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws: WebSocket) => {
  logger.info('Browser client connected');
  const history: { role: string; content: string }[] = [];

  const send = (payload: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  ws.on('message', async (raw) => {
    let msg: { type: string; text: string };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'message' || !msg.text?.trim()) return;

    const userText = msg.text.trim();

    // Build prompt with history
    const turns = history
      .map(h => `${h.role === 'user' ? 'User' : 'Jarvis'}: ${h.content}`)
      .join('\n');
    const prompt = `${SYSTEM_PROMPT}\n\n${turns}\nUser: ${userText}\nJarvis:`;

    send({ type: 'state', state: 'thinking' });

    try {
      const result = await ollama.invoke({ description: prompt });
      const reply  = result.text.trim();

      history.push({ role: 'user',      content: userText });
      history.push({ role: 'assistant', content: reply    });

      send({ type: 'reply', text: reply });
    } catch (err: any) {
      logger.error({ err }, 'Ollama call failed');
      send({ type: 'error', text: `Error: ${err.message}` });
    } finally {
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
