import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from 'pino';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Config } from '../lib/config.js';
import { ModelRouter } from '../router/modelRouter.js';
import { HealthMonitor } from '../lib/health.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DuplexAudioServerOptions {
  config: Config;
  logger: Logger;
  modelRouter: ModelRouter;
  healthMonitor?: HealthMonitor;
}

export class DuplexAudioServer {
  private config: Config;
  private logger: Logger;
  private modelRouter: ModelRouter;
  private healthMonitor?: HealthMonitor;

  private wss: WebSocketServer | null = null;
  private activeConnections = new Set<WebSocket>();

  constructor(options: DuplexAudioServerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.modelRouter = options.modelRouter;
    this.healthMonitor = options.healthMonitor;
  }

  /**
   * Starts the duplex WebSocket audio server.
   */
  start(): void {
    const port = this.config.voiceDuplexPort;
    this.logger.info({ port }, 'Starting Duplex Audio WebSocket server');

    try {
      this.wss = new WebSocketServer({ port });

      this.wss.on('connection', (ws) => {
        this.logger.info('Duplex voice client connected.');
        this.activeConnections.add(ws);
        this.handleClient(ws);
      });

      this.wss.on('error', (err) => {
        this.logger.error({ err }, 'Duplex WebSocket Server error');
        if (this.healthMonitor) {
          this.healthMonitor.transition('voice', 'FAILED', err.message);
        }
      });
    } catch (err: any) {
      this.logger.error({ err }, 'Failed to start Duplex WebSocket Server');
      if (this.healthMonitor) {
        this.healthMonitor.transition('voice', 'FAILED', err.message);
      }
    }
  }

  /**
   * Stops the server and closes all connections.
   */
  stop(): void {
    this.logger.info('Stopping Duplex Audio WebSocket server...');
    for (const ws of this.activeConnections) {
      try {
        ws.close();
      } catch { /* ignore */ }
    }
    this.activeConnections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  private handleClient(ws: WebSocket): void {
    // Buffers and thresholds
    let pcmAccumulator: Buffer[] = [];
    let isProcessing = false;
    let isSpeaking = false;
    let silenceSamples = 0;

    // Default thresholds for 16kHz 16-bit mono (32000 bytes per second)
    // A 100ms chunk has 1600 samples, which is 3200 bytes.
    const interruptThreshold = this.config.voiceDuplexInterruptThreshold;
    const sampleRate = this.config.voiceAudioSampleRate;

    // We expect the client to stream int16 samples.
    ws.on('message', async (data, isBinary) => {
      if (!isBinary) {
        try {
          const payload = JSON.parse(data.toString());
          if (payload.event === 'stop-response') {
            isSpeaking = false;
            this.logger.info('Client finished playing back response audio.');
          }
        } catch { /* ignore text messages */ }
        return;
      }

      const pcmBuffer = data as Buffer;

      // Calculate RMS amplitude of incoming 16-bit PCM chunk
      const int16Array = new Int16Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        pcmBuffer.byteLength / 2
      );

      let sumSq = 0;
      for (let i = 0; i < int16Array.length; i++) {
        const val = int16Array[i] / 32768.0;
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / int16Array.length);

      // Barge-in Check:
      // If user speaks louder than the interrupt threshold, and we are processing/speaking, interrupt them!
      if (rms > interruptThreshold && (isProcessing || isSpeaking)) {
        this.logger.warn({ rms, threshold: interruptThreshold }, 'Barge-in detected! Interrupting active voice synthesis.');
        isProcessing = false;
        isSpeaking = false;
        pcmAccumulator = []; // reset accumulator
        ws.send(JSON.stringify({ event: 'interrupt' }));
        return;
      }

      // Voice Activity & Silence Detection
      // If user is currently speaking or we are accumulating:
      if (rms > 0.005) {
        silenceSamples = 0;
        pcmAccumulator.push(pcmBuffer);
      } else {
        // Accumulate silence. Let's assume a chunk size of 3200 bytes (100ms)
        // If silence duration is > 1.2s (12 chunks), and we have accumulated at least 0.5s of audio, process it!
        silenceSamples++;
        if (pcmAccumulator.length > 0) {
          pcmAccumulator.push(pcmBuffer);
        }

        const silenceDurationMs = (silenceSamples * pcmBuffer.byteLength * 1000) / (sampleRate * 2);
        const accumulatedDurationMs = (pcmAccumulator.length * pcmBuffer.byteLength * 1000) / (sampleRate * 2);

        if (silenceDurationMs > 1200 && accumulatedDurationMs > 500 && !isProcessing && !isSpeaking) {
          this.logger.info({ durationMs: accumulatedDurationMs }, 'End of utterance detected. Triggering processing...');
          isProcessing = true;

          const audioToProcess = Buffer.concat(pcmAccumulator);
          pcmAccumulator = [];
          silenceSamples = 0;

          try {
            // Write WAV file
            const scratchDir = path.resolve(this.config.projectRoot, 'core/test/fixtures');
            if (!fs.existsSync(scratchDir)) {
              fs.mkdirSync(scratchDir, { recursive: true });
            }
            const inputWavPath = path.join(scratchDir, `duplex_input_${Date.now()}.wav`);
            const header = this.writeWavHeader(1, sampleRate, 16, audioToProcess.length);
            fs.writeFileSync(inputWavPath, Buffer.concat([header, audioToProcess]));

            // Run Speech-to-Text (STT)
            const transcription = await this.transcribe(inputWavPath);
            this.logger.info({ transcription }, 'Duplex transcription result');

            // Delete temp input wav
            try { fs.unlinkSync(inputWavPath); } catch { /* ignore */ }

            if (transcription.trim()) {
              // Get response from ModelRouter
              const reply = await this.generateModelReply(transcription);
              this.logger.info({ reply }, 'Duplex response reply');

              if (reply.trim() && isProcessing) {
                // Run Text-to-Speech (TTS)
                const outputWavPath = path.join(scratchDir, `duplex_output_${Date.now()}.wav`);
                await this.synthesize(reply, outputWavPath);

                if (fs.existsSync(outputWavPath) && isProcessing) {
                  // Send output audio back to client
                  const wavBuffer = fs.readFileSync(outputWavPath);
                  ws.send(wavBuffer);
                  isSpeaking = true;

                  // Delete temp output wav
                  try { fs.unlinkSync(outputWavPath); } catch { /* ignore */ }
                }
              }
            }
          } catch (err: any) {
            this.logger.error({ err: err.message }, 'Error during duplex turn processing');
          } finally {
            isProcessing = false;
          }
        } else if (silenceDurationMs > 2000) {
          // Clear accumulator if silence has dragged on with no substantial speech
          pcmAccumulator = [];
          silenceSamples = 0;
        }
      }
    });

    ws.on('close', () => {
      this.logger.info('Duplex voice client disconnected.');
      this.activeConnections.delete(ws);
      isSpeaking = false;
      isProcessing = false;
      pcmAccumulator = [];
    });
  }

  private async transcribe(wavPath: string): Promise<string> {
    const sttScript = path.join(__dirname, 'engines', 'stt_transcribe.py');
    const args = [sttScript, '--wav', wavPath, '--model-path', this.config.voiceSttModelPath];
    if (process.env.JARVIS_TEST_WAKE_MOCK === 'true') {
      args.push('--force-failure'); // tests fallback path
    }

    return new Promise((resolve) => {
      const child = spawn('python', args);
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.on('close', () => {
        try {
          const res = JSON.parse(stdout.trim());
          resolve(res.text || '');
        } catch {
          resolve('');
        }
      });
    });
  }

  private async generateModelReply(userText: string): Promise<string> {
    const taskType = this.config.voiceDuplexModelType === 'cloud' ? 'reasoning' : 'vision';
    const response = await this.modelRouter.route(taskType, {
      description: `User: ${userText}\nKeep your speaking voice reply extremely short (1 to 2 sentences max).`,
    });
    return response.text || '';
  }

  private async synthesize(text: string, outWavPath: string): Promise<void> {
    const ttsScript = path.join(__dirname, 'engines', 'tts_synthesize.py');
    const args = [ttsScript, text, '--wav', outWavPath, '--rate', this.config.voiceTtsRate.toString()];

    return new Promise((resolve, reject) => {
      const child = spawn('python', args);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`TTS failed with code ${code}`));
      });
    });
  }

  private writeWavHeader(numChannels: number, sampleRate: number, bitsPerSample: number, dataLength: number): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
    header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
  }
}
