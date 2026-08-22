import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { DuplexAudioServer } from '../src/voice/DuplexAudioServer.js';
import { ModelRouter } from '../src/router/modelRouter.js';
import { loadConfig } from '../src/lib/config.js';

describe('Phase 14 Continuous Duplex Audio Server tests', () => {
  let server: DuplexAudioServer;
  let modelRouter: ModelRouter;
  const logger = pino({ level: 'silent' });
  const port = 8089;

  beforeEach(() => {
    // Inject custom config
    process.env.JARVIS_DUPLEX_PORT = port.toString();
    process.env.JARVIS_DUPLEX_INTERRUPT_THRESHOLD = '0.02';
    process.env.JARVIS_DUPLEX_MODEL_TYPE = 'local';
    process.env.JARVIS_TEST_WAKE_MOCK = 'true';

    const config = loadConfig(false);
    modelRouter = new ModelRouter();

    modelRouter.register({
      taskTypes: ['vision'], // for local model route
      invoke: async () => ({
        text: 'This is a test response spoken reply.',
      }),
    });

    server = new DuplexAudioServer({
      config,
      logger,
      modelRouter,
    });

    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('allows client connection and starts/stops WebSocket server cleanly', async () => {
    const client = new WebSocket(`ws://localhost:${port}`);
    
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => {
        resolve();
      });
      client.on('error', (err) => {
        reject(err);
      });
    });

    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('computes RMS amplitude and detects barge-in user voice interruption', async () => {
    const client = new WebSocket(`ws://localhost:${port}`);
    
    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });

    let interruptReceived = false;
    client.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.event === 'interrupt') {
          interruptReceived = true;
        }
      } catch { /* ignore */ }
    });

    // 1. Send speech to start accumulator
    const speechChunk = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      speechChunk.writeInt16LE(i % 2 === 0 ? 2000 : -2000, i * 2);
    }
    for (let i = 0; i < 6; i++) {
      client.send(speechChunk);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // 2. Send silence to trigger server response processing (isProcessing -> isSpeaking)
    const silentChunk = Buffer.alloc(3200);
    for (let i = 0; i < 13; i++) {
      client.send(silentChunk);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Wait until server starts speaking (receives binary wav buffer)
    await new Promise<void>((resolve) => {
      client.on('message', (data) => {
        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
          resolve();
        }
      });
    });

    // 3. Now the server is currently speaking. Send a loud chunk to trigger VAD barge-in!
    const loudChunk = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      loudChunk.writeInt16LE(i % 2 === 0 ? 30000 : -30000, i * 2);
    }
    client.send(loudChunk);
    
    // Allow dynamic polling wait for server async event handling
    let attempts = 0;
    while (!interruptReceived && attempts < 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    expect(interruptReceived).toBe(true);
    client.close();
  });

  it('triggers transcription and response synthesis on sustained user silence', async () => {
    const client = new WebSocket(`ws://localhost:${port}`);
    
    await new Promise<void>((resolve) => {
      client.on('open', resolve);
    });

    let binaryReplyReceived = false;
    client.on('message', (data) => {
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        binaryReplyReceived = true;
      }
    });

    // Send 6 speech chunks (total 600ms of simulated speech, amplitude > noise floor)
    const speechChunk = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) {
      speechChunk.writeInt16LE(i % 2 === 0 ? 2000 : -2000, i * 2);
    }
    for (let i = 0; i < 6; i++) {
      client.send(speechChunk);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Send 13 silence chunks (total 1300ms, silence threshold <= 0.005)
    const silentChunk = Buffer.alloc(3200);
    for (let i = 0; i < 13; i++) {
      client.send(silentChunk);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Wait dynamically for the asynchronous STT -> LLM -> TTS loop to run
    let attempts = 0;
    while (!binaryReplyReceived && attempts < 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    // Verify a binary response containing the WAV audio reply was received
    expect(binaryReplyReceived).toBe(true);
    client.close();
  });
});
