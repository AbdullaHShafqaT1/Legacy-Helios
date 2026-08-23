import { Logger } from 'pino';
import { EventEmitter } from 'node:events';
import { JarvisEventBus } from '../events/bus.js';

export interface AudioEngine extends EventEmitter {
  init(): Promise<void>;
  startListening(): void;
  stopListening(): void;
  speak(text: string): Promise<void>;
  stopSpeaking(): void;
  startTranscription?(): void;
  on(event: 'wake-word', listener: () => void): this;
  on(event: 'transcription', listener: (text: string, confidence: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface VoiceManagerConfig {
  sttConfidenceThreshold: number;
  wakeWordSensitivity: number;
  continuousListening?: boolean;
  continuousTimeoutMs?: number;
  eventBus?: JarvisEventBus;
}

export class VoiceManager extends EventEmitter {
  private engine: AudioEngine;
  private logger: Logger;
  private config: VoiceManagerConfig;
  private isListeningForCommand = false;
  private continuousTimer: NodeJS.Timeout | null = null;

  constructor(engine: AudioEngine, logger: Logger, config: VoiceManagerConfig) {
    super();
    this.engine = engine;
    this.logger = logger;
    this.config = config;

    this.engine.on('wake-word', this.handleWakeWord.bind(this));
    this.engine.on('transcription', this.handleTranscription.bind(this));
    this.engine.on('error', (err) => {
      this.logger.error({ err }, 'Audio engine error');
    });
  }

  private stopCheckInterval: NodeJS.Timeout | null = null;
  private silenceReminderInterval: NodeJS.Timeout | null = null;
  private lastActiveTimestamp = Date.now();

  async init(): Promise<void> {
    await this.engine.init();
    this.engine.startListening();
    this.logger.info('VoiceManager initialized and listening for wake word.');

    // Start polling for dashboard stop signal file
    import('node:fs').then((fs) => {
      import('node:path').then((path) => {
        const stopFilePath = path.join(process.cwd(), 'memory-store', 'STOP_LISTENING');
        this.stopCheckInterval = setInterval(() => {
          if (fs.existsSync(stopFilePath)) {
            this.logger.warn('Voice listening stopped via Dashboard request.');
            try { fs.unlinkSync(stopFilePath); } catch {}
            this.stopListening();
            this.emit('stop');
            if (!process.env.VITEST) {
              process.exit(0);
            }
          }
        }, 1000);
      });
    });

    // Start 1-minute reminder timer when in command listening mode
    this.silenceReminderInterval = setInterval(() => {
      if (this.isListeningForCommand) {
        const inactiveTime = Date.now() - this.lastActiveTimestamp;
        if (inactiveTime >= 60000) { // 1 minute
          this.logger.info('User silent for 1 minute in command mode. Reminding user...');
          this.lastActiveTimestamp = Date.now();
          this.speak("I'm still listening.").catch(() => {});
        }
      }
    }, 5000);
  }

  stopListening(): void {
    if (this.stopCheckInterval) {
      clearInterval(this.stopCheckInterval);
      this.stopCheckInterval = null;
    }
    if (this.silenceReminderInterval) {
      clearInterval(this.silenceReminderInterval);
      this.silenceReminderInterval = null;
    }
    this.engine.stopListening();
  }

  async speak(text: string): Promise<void> {
    try {
      await this.engine.speak(text);
    } catch (err: any) {
      this.logger.error({ err }, 'TTS playback failed. Falling back to text output.');
      console.log(`[Jarvis Speaks]: ${text}`);
    } finally {
      if (this.config.continuousListening || this.isListeningForCommand) {
        if (typeof this.engine.startTranscription === 'function') {
          this.engine.startTranscription();
        }
        if (this.config.continuousListening) {
          this.isListeningForCommand = true;
          this.refreshContinuousTimer();
        }
      } else {
        this.engine.startListening();
      }
    }
  }

  private refreshContinuousTimer() {
    if (this.continuousTimer) {
      clearTimeout(this.continuousTimer);
    }
    const timeout = this.config.continuousTimeoutMs ?? 10000;
    this.continuousTimer = setTimeout(() => {
      this.logger.info('Continuous listening turn-taking timed out. Returning to wake word mode.');
      this.isListeningForCommand = false;
      this.continuousTimer = null;
      this.engine.startListening();
    }, timeout);
  }

  private handleWakeWord(): void {
    this.logger.info('Wake word detected.');
    this.engine.stopSpeaking();
    
    this.isListeningForCommand = true;
    this.lastActiveTimestamp = Date.now();
    this.emit('wake-word');
  }

  private handleTranscription(text: string, confidence: number): void {
    if (!this.isListeningForCommand) {
      return;
    }
    this.lastActiveTimestamp = Date.now();

    if (this.continuousTimer) {
      clearTimeout(this.continuousTimer);
      this.continuousTimer = null;
    }

    const commandText = text.trim().toLowerCase();

    // Voice-triggered stop (halting is allowed, approval is blocked)
    if (commandText === 'stop' || commandText === 'cancel') {
      this.logger.warn(`Voice-triggered emergency-stop command received: "${text}"`);
      this.engine.stopSpeaking();
      this.isListeningForCommand = false;
      if (this.config.eventBus) {
        this.config.eventBus.emit('queue:emergency-stop');
      }
      this.emit('stop');
      this.engine.startListening();
      return;
    }

    this.isListeningForCommand = false;

    if (!text || text.trim() === '') {
      this.logger.info('Empty transcription. Continuing to listen for command.');
      this.isListeningForCommand = true;
      if (typeof this.engine.startTranscription === 'function') {
        this.engine.startTranscription();
      }
      return;
    }

    if (confidence < this.config.sttConfidenceThreshold) {
      this.logger.warn({ confidence, threshold: this.config.sttConfidenceThreshold }, 'Transcription confidence below threshold. Requesting clarification.');
      this.isListeningForCommand = true;
      this.speak("I didn't quite catch that. Could you repeat?").catch(e => {
        this.logger.error({ err: e }, 'Failed to speak clarification request');
      });
      return;
    }

    this.emit('command', text.trim());
  }
}
