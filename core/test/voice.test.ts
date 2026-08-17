import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { VoiceManager } from '../src/voice/VoiceManager.js';
import { MockAudioEngine } from '../src/voice/engines/MockAudioEngine.js';

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
