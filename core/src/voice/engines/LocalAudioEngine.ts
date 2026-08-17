import { EventEmitter } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import { AudioEngine } from '../VoiceManager.js';
import { Logger } from 'pino';

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
    // Objective: Fail fast if hardware/engine is unavailable.
    // We check for python to ensure the subprocess environment is sane.
    // In a production environment, we'd check for whisper/piper binaries.
    try {
      const pyCheck = spawn('python', ['--version']);
      await new Promise<void>((resolve, reject) => {
        pyCheck.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Python not found or failed with code ${code}`));
        });
        pyCheck.on('error', reject);
      });
    } catch (err: any) {
      throw new Error(`Audio subsystem unavailable: ${err.message}. Please use MockAudioEngine or install required dependencies (Python, openWakeWord, whisper.cpp, Piper).`);
    }
  }

  startListening(): void {
    if (this.isListening) return;
    this.isListening = true;

    // In a fully deployed setup, this spawns openWakeWord bridging script.
    // For local-first privacy, this process buffers audio locally and emits 'WAKE_WORD_DETECTED'
    // ONLY when the wake word is detected. No audio leaves the machine.
    this.wakeWordProcess = spawn('python', ['-c', `
import sys
# Real implementation would import openwakeword and pyaudio here.
while True:
    line = sys.stdin.readline()
    if not line: break
    if 'trigger' in line:
        print('WAKE_WORD_DETECTED', flush=True)
`]);

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
  }

  private startTranscription(): void {
    // Starts whisper.cpp or similar local STT stream recording.
    // It captures a command and returns JSON with transcription and confidence.
    this.logger.info('STT Engine recording...');
    
    this.sttProcess = spawn('python', ['-c', `
import sys
# Real implementation would run whisper local model
print('{"text": "submit a task to refactor the database", "confidence": 0.98}', flush=True)
`]);

    this.sttProcess.stdout?.on('data', (data) => {
      try {
        const result = JSON.parse(data.toString());
        if (result.text && result.confidence !== undefined) {
          this.emit('transcription', result.text, result.confidence);
        }
      } catch (e) {
        // Ignore parse errors from non-json output
      }
    });
  }

  stopListening(): void {
    this.isListening = false;
    if (this.wakeWordProcess) {
      this.wakeWordProcess.kill();
      this.wakeWordProcess = null;
    }
    if (this.sttProcess) {
      this.sttProcess.kill();
      this.sttProcess = null;
    }
  }

  async speak(text: string): Promise<void> {
    this.stopSpeaking(); // Barge-in support

    return new Promise((resolve, reject) => {
      // Spawn Piper TTS or similar local TTS
      // In production: echo "text" | piper --model ... | aplay
      this.ttsProcess = spawn('python', ['-c', `
import sys, time
print("TTS STARTING: " + sys.argv[1], flush=True)
time.sleep(1) # Mocking speech duration
print("TTS FINISHED", flush=True)
      `, text]);

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
