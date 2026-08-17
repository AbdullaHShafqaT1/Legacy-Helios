import { EventEmitter } from 'node:events';
import { AudioEngine } from '../VoiceManager.js';

export class MockAudioEngine extends EventEmitter implements AudioEngine {
  private isListening = false;
  private isSpeaking = false;
  
  async init(): Promise<void> {
    // Mock initialization
    return Promise.resolve();
  }

  startListening(): void {
    this.isListening = true;
  }

  stopListening(): void {
    this.isListening = false;
  }

  async speak(text: string): Promise<void> {
    this.isSpeaking = true;
    return new Promise((resolve) => {
      // Simulate speech duration
      setTimeout(() => {
        if (this.isSpeaking) {
          this.isSpeaking = false;
          resolve();
        }
      }, 500); // 500ms mock speech duration
    });
  }

  stopSpeaking(): void {
    this.isSpeaking = false;
  }

  // Helper methods to simulate hardware events in tests
  simulateWakeWord(): void {
    if (this.isListening) {
      this.emit('wake-word');
    }
  }

  simulateTranscription(text: string, confidence: number): void {
    if (this.isListening) {
      this.emit('transcription', text, confidence);
    }
  }

  simulateError(error: Error): void {
    this.emit('error', error);
  }
}
