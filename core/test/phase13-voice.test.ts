import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalAudioEngine } from '../src/voice/engines/LocalAudioEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Phase 13 Voice Engine Hardening', () => {
  let logger: pino.Logger;
  let engine: LocalAudioEngine;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    engine = new LocalAudioEngine(logger);
  });

  afterEach(() => {
    // Make sure we stop process if running
    try {
      (engine as any).switchEngine('openwakeword');
    } catch {}
  });

  it('reports the active engine', () => {
    expect(engine.getActiveEngine()).toBe('openwakeword');
  });

  it('switches between engines dynamically', () => {
    engine.switchEngine('custom-energy');
    expect(engine.getActiveEngine()).toBe('custom-energy');

    engine.switchEngine('openwakeword');
    expect(engine.getActiveEngine()).toBe('openwakeword');
  });

  it('fails fast and falls back to openwakeword when a secondary engine crashes', async () => {
    // Temporarily trigger failure for porcupine by clearing access key
    process.env.JARVIS_PORCUPINE_ACCESS_KEY = '';
    process.env.JARVIS_WAKE_WORD_ENGINE = 'porcupine';
    
    const config = {
      voiceWakeWordEngine: 'porcupine',
      voicePorcupineAccessKey: '',
      voiceWakeWordThreshold: 0.1,
      voiceAudioSampleRate: 16000,
    };

    // If we call startListening, it will try to spawn porcupine, fail immediately, and fallback.
    engine.startListening();

    // Give it a short moment to exit the spawned python process and trigger 'close' event handler
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The engine should automatically fallback to openwakeword
    expect(engine.getActiveEngine()).toBe('openwakeword');
  });
});
