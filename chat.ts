#!/usr/bin/env tsx
/**
 * Jarvis Local Chat REPL
 * Talks directly to OllamaConnector (llava:latest by default).
 * Run: npx tsx chat.ts
 */

import readline from 'node:readline';
import { OllamaConnector } from './connectors/ollama/OllamaConnector.js';
import pino from 'pino';

const MODEL  = process.env.JARVIS_OLLAMA_MODEL   ?? 'llava:latest';
const BASE_URL = process.env.JARVIS_OLLAMA_BASE_URL ?? 'http://localhost:11434';

const logger = pino({ level: 'warn' }); // suppress info noise during chat

const ollama = new OllamaConnector({
  model: MODEL,
  baseUrl: BASE_URL,
  maxRetries: 2,
  timeoutMs: 120_000,
  logger,
});

// Rolling conversation history for multi-turn context
const history: { role: 'user' | 'assistant'; content: string }[] = [];

const SYSTEM_PROMPT =
  'You are Jarvis, an intelligent AI assistant running locally. Be concise, helpful, and direct.';

function buildPrompt(userMessage: string): string {
  // Prepend system prompt + history to give the model context
  const turns = history
    .map(h => `${h.role === 'user' ? 'User' : 'Jarvis'}: ${h.content}`)
    .join('\n');
  return `${SYSTEM_PROMPT}\n\n${turns}\nUser: ${userMessage}\nJarvis:`;
}

async function chat(userMessage: string): Promise<string> {
  const prompt = buildPrompt(userMessage);
  const res = await ollama.invoke({ description: prompt });
  const reply = res.text.trim();
  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: reply });
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
