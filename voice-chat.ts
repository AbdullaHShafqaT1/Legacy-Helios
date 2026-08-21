#!/usr/bin/env tsx
/**
 * Jarvis Voice Chat
 * Full loop: Wake Word → STT → Ollama (llava) → TTS
 * Run: npx tsx voice-chat.ts
 */

import { OllamaConnector } from './connectors/ollama/OllamaConnector.js';
import { LocalAudioEngine } from './core/src/voice/engines/LocalAudioEngine.js';
import { VoiceManager } from './core/src/voice/VoiceManager.js';
import pino from 'pino';

const MODEL = process.env.JARVIS_OLLAMA_MODEL ?? 'llava:latest';
const BASE_URL = process.env.JARVIS_OLLAMA_BASE_URL ?? 'http://localhost:11434';

const logger = pino({ level: 'warn' });

const ollama = new OllamaConnector({ model: MODEL, baseUrl: BASE_URL, maxRetries: 2, timeoutMs: 120_000, logger });

const SYSTEM_PROMPT =
  'You are Jarvis, a concise and helpful AI assistant. Keep all responses under 3 sentences — you are speaking aloud, not writing.';

const history: { role: string; content: string }[] = [];

function buildPrompt(userMessage: string): string {
  const turns = history.map(h => `${h.role === 'user' ? 'User' : 'Jarvis'}: ${h.content}`).join('\n');
  return `${SYSTEM_PROMPT}\n\n${turns}\nUser: ${userMessage}\nJarvis:`;
}

async function respond(userMessage: string, voiceManager: VoiceManager): Promise<void> {
  console.log(`\n🎤 You said: "${userMessage}"`);
  process.stdout.write('🤖 Jarvis: ');

  try {
    const res = await ollama.invoke({ description: buildPrompt(userMessage) });
    const reply = res.text.trim();

    console.log(reply + '\n');
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: reply });

    await voiceManager.speak(reply);
  } catch (err: any) {
    const errMsg = 'Sorry, I had trouble processing that.';
    console.error(`[Error] ${err.message}`);
    await voiceManager.speak(errMsg).catch(() => { });
  }
}

async function main() {
  console.log(`\n🤖  Jarvis Voice Chat  [model: ${MODEL}]\n`);

  const engine = new LocalAudioEngine(logger);

  const voiceManager = new VoiceManager(engine, logger, {
    sttConfidenceThreshold: 0.6,
    wakeWordSensitivity: 0.5,
  });

  voiceManager.on('command', (text: string) => {
    respond(text, voiceManager).catch(err => {
      console.error('[Fatal respond error]', err.message);
    });
  });

  voiceManager.on('error', (err: Error) => {
    console.error(`[Voice error] ${err.message}`);
  });

  await voiceManager.init();

  console.log('✅ Listening... Say the wake word then speak your command.');
  console.log('   Press Ctrl+C to quit.\n');

  // Keep process alive
  process.stdin.resume();

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    voiceManager.stopListening();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Failed to start voice chat:', err.message);
  process.exit(1);
});
