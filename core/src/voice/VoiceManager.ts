import { Logger } from 'pino';
import { EventEmitter } from 'node:events';

export interface AudioEngine extends EventEmitter {
  init(): Promise<void>;
  startListening(): void;
  stopListening(): void;
  speak(text: string): Promise<void>;
  stopSpeaking(): void;
  on(event: 'wake-word', listener: () => void): this;
  on(event: 'transcription', listener: (text: string, confidence: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface VoiceManagerConfig {
  sttConfidenceThreshold: number;
  wakeWordSensitivity: number;
}

export class VoiceManager extends EventEmitter {
  private engine: AudioEngine;
  private logger: Logger;
  private config: VoiceManagerConfig;
  private isListeningForCommand = false;

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

  async init(): Promise<void> {
    await this.engine.init();
    this.engine.startListening();
    this.logger.info('VoiceManager initialized and listening for wake word.');
  }

  async speak(text: string): Promise<void> {
    try {
      await this.engine.speak(text);
    } catch (err: any) {
      this.logger.error({ err }, 'TTS playback failed. Falling back to text output.');
      console.log(`[Jarvis Speaks]: ${text}`);
    }
  }

  private handleWakeWord(): void {
    this.logger.info('Wake word detected.');
    // Barge-in: interrupt any ongoing TTS
    this.engine.stopSpeaking();
    
    this.isListeningForCommand = true;
    this.emit('wake-word');
  }

  private handleTranscription(text: string, confidence: number): void {
    if (!this.isListeningForCommand) {
      return; // Ignore if wake word hasn't triggered
    }
    
    this.logger.info({ transcription: text, confidence }, 'Received transcription');
    this.isListeningForCommand = false;

    if (!text || text.trim() === '') {
      this.logger.info('Wake word false positive or empty transcription. Returning to idle.');
      return;
    }

    if (confidence < this.config.sttConfidenceThreshold) {
      this.logger.warn({ confidence, threshold: this.config.sttConfidenceThreshold }, 'Transcription confidence below threshold. Requesting clarification.');
      this.speak("I didn't quite catch that. Could you repeat?").catch(e => {
        this.logger.error({ err: e }, 'Failed to speak clarification request');
      });
      return;
    }

    this.emit('command', text.trim());
  }
}
