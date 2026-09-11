#!/usr/bin/env tsx
/**
 * Jarvis Local Chat REPL
 * Talks directly to OllamaConnector (llava:latest by default).
 * Run: npx tsx chat.ts
 */

import readline from 'node:readline';
import { OllamaConnector } from './connectors/ollama/OllamaConnector.js';
import { openCliContext, CliContext } from './core/src/bootstrap.js';
import pino from 'pino';

const MODEL  = process.env.JARVIS_OLLAMA_MODEL   ?? 'llava:latest';
const BASE_URL = process.env.JARVIS_OLLAMA_BASE_URL ?? 'http://localhost:11434';

const logger = pino({ level: 'warn' }); // suppress info noise during chat

let cliCtx: CliContext | null = null;
try {
  cliCtx = openCliContext('jarvis-chat');
} catch (err: any) {
  logger.warn({ err: err.message }, 'Failed to initialize database/memory context in chat');
}

const ollama = new OllamaConnector({
  model: MODEL,
  baseUrl: BASE_URL,
  maxRetries: 2,
  timeoutMs: 120_000,
  logger,
});

// Rolling conversation history for multi-turn context
const history: { role: 'user' | 'assistant'; content: string }[] = [];

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
    logger.warn({ err: dbErr.message }, 'Failed to load past chat turns from SQLite');
  }
}

const SYSTEM_PROMPT =
  'You are Jarvis, an intelligent AI assistant running locally. Be concise, helpful, and direct.\n' +
  'You have native OS-level mouse and desktop automation capabilities (DPI-aware cursor positioning, clicks, drag-and-drop, scrolling, and visual targeting).';

async function buildPrompt(userMessage: string): Promise<string> {
  let memoryContext = '';
  if (cliCtx?.memoryManager) {
    try {
      const memories = await cliCtx.memoryManager.query(userMessage, { limit: 3 }, 'system');
      if (memories.length > 0) {
        memoryContext = `\nRelevant Past Context:\n${memories.map(m => `- ${m.content}`).join('\n')}\n`;
      }
    } catch (memErr: any) {
      logger.warn({ err: memErr.message }, 'Failed to query semantic memories for chat prompt');
    }
  }

  // Prepend system prompt + memory + history to give the model context
  const turns = history
    .map(h => `${h.role === 'user' ? 'User' : 'Jarvis'}: ${h.content}`)
    .join('\n');
  return `${SYSTEM_PROMPT}${memoryContext}\n\n${turns}\nUser: ${userMessage}\nJarvis:`;
}

async function chat(userMessage: string): Promise<string> {
  // Persist incoming user turn to SQLite via MemoryManager
  if (cliCtx?.memoryManager) {
    cliCtx.memoryManager.store({
      content: `User: ${userMessage}`,
      sourceAgent: 'system',
      tag: 'chat-turn',
    }).catch(err => logger.warn({ err: err.message }, 'Failed to persist user turn to memory'));
  }

  const prompt = await buildPrompt(userMessage);
  const res = await ollama.invoke({ description: prompt });
  const reply = res.text.trim();

  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: reply });

  // Persist assistant reply to SQLite via MemoryManager
  if (cliCtx?.memoryManager) {
    cliCtx.memoryManager.store({
      content: `Jarvis: ${reply}`,
      sourceAgent: 'system',
      tag: 'chat-turn',
    }).catch(err => logger.warn({ err: err.message }, 'Failed to persist assistant reply to memory'));
  }

  return reply;
}

async function main() {
  console.log(`\n🤖  Jarvis Local Chat  [model: ${MODEL}  |  ${BASE_URL}]`);
  console.log('    Type your message and press Enter. Ctrl+C or "exit" to quit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = () => {
    rl.question('You: ', async (input) => {
      const msg = input.trim();
      if (!msg) { ask(); return; }
      if (msg.toLowerCase() === 'exit' || msg.toLowerCase() === 'quit') {
        console.log('\nGoodbye.\n');
        rl.close();
        process.exit(0);
      }

      process.stdout.write('Jarvis: ');
      try {
        const reply = await chat(msg);
        console.log(reply + '\n');
      } catch (err: any) {
        console.error(`\n[Error] ${err.message}\n`);
      }

      ask();
    });
  };

  ask();
}

main();

