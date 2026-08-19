import { EventEmitter } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import { AudioEngine } from '../VoiceManager.js';
import { Logger } from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../lib/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * LocalAudioEngine class implements the AudioEngine interface.
 * Uses real offline local speech engines (openWakeWord, Whisper, pyttsx3).
 */
export class LocalAudioEngine extends EventEmitter implements AudioEngine {
  private wakeWordProcess: ChildProcess | null = null;
  private ttsProcess: ChildProcess | null = null;
  private sttProcess: ChildProcess | null = null;
  private logger: Logger;
  private isListening = false;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  async init(): Promise<void> {
    // Fail fast if python or required speech libraries are missing
    try {
      const pyCheck = spawn('python', ['--version']);
      await new Promise<void>((resolve, reject) => {
        pyCheck.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Python not found or failed with code ${code}`));
        });
        pyCheck.on('error', reject);
      });

      const depCheck = spawn('python', ['-c', 'import openwakeword, whisper, pyttsx3, sounddevice, scipy']);
      await new Promise<void>((resolve, reject) => {
        depCheck.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Missing required speech packages (openwakeword, whisper, pyttsx3, sounddevice, scipy)`));
        });
        depCheck.on('error', reject);
      });
    } catch (err: any) {
      throw new Error(`Audio subsystem unavailable: ${err.message}. Please run pip install -r requirements-speech.txt.`);
    }
  }

  startListening(): void {
    if (this.isListening) return;
    this.isListening = true;

    const config = loadConfig(false);
    const wakeScript = path.join(__dirname, 'wake_word_detect.py');
    const args = [wakeScript];

    // Support file-based testing via environment variables
    if (process.env.JARVIS_WAKE_WAV) {
      args.push('--wav', process.env.JARVIS_WAKE_WAV);
    }
    
    const threshold = process.env.JARVIS_WAKE_WORD_THRESHOLD || 
                      process.env.JARVIS_WAKE_WORD_SENSITIVITY || 
                      config.voiceWakeWordThreshold.toString();
    args.push('--threshold', threshold);

    this.logger.info({ args }, 'Spawning wake word detector process');
    this.wakeWordProcess = spawn('python', args);

    this.wakeWordProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      if (output.includes('WAKE_WORD_DETECTED')) {
        this.emit('wake-word');
        this.startTranscription();
      }
    });

    this.wakeWordProcess.on('error', (err) => {
      this.logger.error({ err }, 'Wake word process error');
      this.emit('error', err);
    });

    this.wakeWordProcess.on('close', () => {
      this.wakeWordProcess = null;
    });
  }

  private startTranscription(): void {
    this.logger.info('STT Engine recording/transcribing...');
    
    const sttScript = path.join(__dirname, 'stt_transcribe.py');
    const args = [sttScript];

    if (process.env.JARVIS_STT_WAV) {
      args.push('--wav', process.env.JARVIS_STT_WAV);
    }

    this.sttProcess = spawn('python', args);

    let stdoutBuffer = '';

    this.sttProcess.stdout?.on('data', (data) => {
      stdoutBuffer += data.toString();
    });

    this.sttProcess.on('close', (code) => {
      this.sttProcess = null;
      if (code === 0) {
        try {
          const lines = stdoutBuffer.trim().split('\n');
          // Get the last line in case of warnings printed to stdout
          const lastLine = lines[lines.length - 1];
          const result = JSON.parse(lastLine);
          if (result.text !== undefined && result.confidence !== undefined) {
            this.emit('transcription', result.text, result.confidence);
          } else if (result.error) {
            if (this.isListening) {
              this.emit('error', new Error(`STT failed: ${result.error}`));
            }
          }
        } catch (e: any) {
          if (this.isListening) {
            this.emit('error', new Error(`Failed to parse STT response: ${stdoutBuffer}`));
          }
        }
      } else {
        if (this.isListening) {
          this.emit('error', new Error(`STT process exited with code ${code}`));
        }
      }
    });

    this.sttProcess.on('error', (err) => {
      this.logger.error({ err }, 'STT process error');
      this.emit('error', err);
    });
  }

  stopListening(): void {
    this.isListening = false;
    if (this.wakeWordProcess) {
      this.wakeWordProcess.kill('SIGKILL');
      this.wakeWordProcess = null;
    }
    if (this.sttProcess) {
      this.sttProcess.kill('SIGKILL');
      this.sttProcess = null;
    }
  }

  async speak(text: string): Promise<void> {
    this.stopSpeaking(); // Barge-in support

    const config = loadConfig(false);
    return new Promise((resolve, reject) => {
      const ttsScript = path.join(__dirname, 'tts_synthesize.py');
      const args = [ttsScript, text];

      if (process.env.JARVIS_TTS_OUTPUT_WAV) {
        args.push('--wav', process.env.JARVIS_TTS_OUTPUT_WAV);
      }

      const rate = process.env.JARVIS_TTS_RATE || config.voiceTtsRate.toString();
      args.push('--rate', rate);

      this.ttsProcess = spawn('python', args);

      this.ttsProcess.on('close', (code) => {
        this.ttsProcess = null;
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`TTS failed with code ${code}`));
        }
      });

      this.ttsProcess.on('error', (err) => {
        this.ttsProcess = null;
        reject(err);
      });
    });
  }

  stopSpeaking(): void {
    if (this.ttsProcess) {
      this.ttsProcess.kill('SIGKILL');
      this.ttsProcess = null;
      this.logger.info('TTS playback interrupted (Barge-In).');
    }
  }
}
