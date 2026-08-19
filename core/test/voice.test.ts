import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { VoiceManager } from '../src/voice/VoiceManager.js';
import { MockAudioEngine } from '../src/voice/engines/MockAudioEngine.js';
import { LocalAudioEngine } from '../src/voice/engines/LocalAudioEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('VoiceManager', () => {
  let engine: MockAudioEngine;
  let logger: pino.Logger;
  let manager: VoiceManager;

  beforeEach(() => {
    engine = new MockAudioEngine();
    logger = pino({ level: 'silent' });
    manager = new VoiceManager(engine, logger, {
      sttConfidenceThreshold: 0.8,
      wakeWordSensitivity: 0.5,
    });
  });

  it('initializes and starts listening', async () => {
    const initSpy = vi.spyOn(engine, 'init');
    const startSpy = vi.spyOn(engine, 'startListening');

    await manager.init();

    expect(initSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
  });

  it('ignores transcriptions if wake word has not triggered', async () => {
    await manager.init();
    
    let commandEmitted = false;
    manager.on('command', () => { commandEmitted = true; });

    engine.simulateTranscription('hello world', 0.9);

    expect(commandEmitted).toBe(false);
  });

  it('processes transcription after wake word', async () => {
    await manager.init();
    
    let receivedCommand = '';
    manager.on('command', (cmd) => { receivedCommand = cmd; });

    engine.simulateWakeWord();
    engine.simulateTranscription('hello world', 0.9);

    expect(receivedCommand).toBe('hello world');
  });

  it('rejects transcription below confidence threshold', async () => {
    await manager.init();
    
    const speakSpy = vi.spyOn(engine, 'speak');
    let commandEmitted = false;
    manager.on('command', () => { commandEmitted = true; });

    engine.simulateWakeWord();
    engine.simulateTranscription('garbled text', 0.5);

    expect(commandEmitted).toBe(false);
    expect(speakSpy).toHaveBeenCalledWith("I didn't quite catch that. Could you repeat?");
  });

  it('handles barge-in by stopping TTS when wake word triggers', async () => {
    await manager.init();
    const stopSpeakingSpy = vi.spyOn(engine, 'stopSpeaking');
    
    // Start speaking
    manager.speak('This is a long sentence.');
    
    // Simulate interrupt
    engine.simulateWakeWord();

    expect(stopSpeakingSpy).toHaveBeenCalled();
  });
});

describe('LocalAudioEngine Integration (Real Engines)', () => {
  let logger: pino.Logger;
  let engine: LocalAudioEngine;
  let tempOutWav: string;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    engine = new LocalAudioEngine(logger);
    tempOutWav = path.join(os.tmpdir(), `jarvis-tts-test-${Date.now()}.wav`);
    
    // Clear speech env vars by default
    delete process.env.JARVIS_WAKE_WAV;
    delete process.env.JARVIS_STT_WAV;
    delete process.env.JARVIS_TTS_OUTPUT_WAV;
    delete process.env.JARVIS_WAKE_WORD_THRESHOLD;
  });

  afterEach(() => {
    if (fs.existsSync(tempOutWav)) {
      try {
        fs.unlinkSync(tempOutWav);
      } catch {}
    }
    delete process.env.JARVIS_WAKE_WAV;
    delete process.env.JARVIS_STT_WAV;
    delete process.env.JARVIS_TTS_OUTPUT_WAV;
    delete process.env.JARVIS_WAKE_WORD_THRESHOLD;
  });

  it('initializes successfully checking dependencies', async () => {
    await expect(engine.init()).resolves.not.toThrow();
  });

  it('detects wake word from real audio fixture', async () => {
    const fixturePath = path.resolve(__dirname, 'fixtures', 'jarvis_wake.wav');
    expect(fs.existsSync(fixturePath)).toBe(true);

    process.env.JARVIS_WAKE_WAV = fixturePath;
    process.env.JARVIS_WAKE_WORD_THRESHOLD = '0.1';

    await engine.init();

    const wakeWordPromise = new Promise<void>((resolve) => {
      engine.once('wake-word', () => {
        resolve();
      });
    });

    engine.startListening();
    await wakeWordPromise;
    engine.stopListening();
  });

  it('transcribes speech from real audio fixture', async () => {
    const wakeFixture = path.resolve(__dirname, 'fixtures', 'jarvis_wake.wav');
    const sttFixture = path.resolve(__dirname, 'fixtures', 'refactor_task.wav');
    expect(fs.existsSync(sttFixture)).toBe(true);

    process.env.JARVIS_WAKE_WAV = wakeFixture;
    process.env.JARVIS_STT_WAV = sttFixture;
    process.env.JARVIS_WAKE_WORD_THRESHOLD = '0.1';

    await engine.init();

    const transcriptionPromise = new Promise<{ text: string; confidence: number }>((resolve) => {
      engine.once('transcription', (text, confidence) => {
        resolve({ text, confidence });
      });
    });

    engine.startListening();
    const result = await transcriptionPromise;
    engine.stopListening();

    expect(result.text.toLowerCase()).toContain('refactor');
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it('synthesizes speech to file and verifies audio properties', async () => {
    process.env.JARVIS_TTS_OUTPUT_WAV = tempOutWav;
    await engine.init();

    await engine.speak('This is a test of the text to speech engine output validation.');
    
    expect(fs.existsSync(tempOutWav)).toBe(true);
    const stats = fs.statSync(tempOutWav);
    expect(stats.size).toBeGreaterThan(44); // WAV header is 44 bytes, audio content must exist

    // Verify WAV format header (RIFF, WAVE)
    const buffer = fs.readFileSync(tempOutWav);
    const riff = buffer.toString('utf8', 0, 4);
    const wave = buffer.toString('utf8', 8, 12);
    expect(riff).toBe('RIFF');
    expect(wave).toBe('WAVE');
  });

  it('supports barge-in interruption cleanly mid-synthesis', async () => {
    process.env.JARVIS_TTS_OUTPUT_WAV = tempOutWav;
    await engine.init();

    // Start speaking in background
    const speakPromise = engine.speak('This is a very long synthesis message to ensure the subprocess has time to be spawned and interrupted.');
    
    // Instantly interrupt
    engine.stopSpeaking();

    // The promise resolves when successfully killed
    await expect(speakPromise).resolves.not.toThrow();
  });
}, 30000);
