import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { denyAllPrompt } from '../src/permissions/gatekeeper.js';
import { VoiceManager } from '../src/voice/VoiceManager.js';
import { MockAudioEngine } from '../src/voice/engines/MockAudioEngine.js';
import { createLogger } from '../src/lib/logger.js';
import { OverrideHookConnector } from '../../connectors/override/OverrideHookConnector.js';
import { DesktopConnector } from '../../connectors/desktop/DesktopConnector.js';

describe('Phase 11: Safety Override Hooks & Turn-Taking Voice tests', () => {
  let ctx: any;
  let desktopConnector: DesktopConnector;
  let overrideHookConnector: OverrideHookConnector;
  let voiceManager: VoiceManager;
  let audioEngine: MockAudioEngine;
  let logger: any;

  beforeEach(async () => {
    ctx = bootstrap(denyAllPrompt, 'test-phase11', false);
    desktopConnector = ctx.desktopConnector;
    overrideHookConnector = ctx.overrideHookConnector;

    // Spy on the private executeScript method to prevent invoking real PowerShell scripts
    vi.spyOn(desktopConnector as any, 'executeScript').mockResolvedValue(undefined);

    // Mock captureScreen to avoid invoking real System.Windows.Forms screen captures during tests
    vi.spyOn(ctx.computerVisionConnector, 'captureScreen').mockImplementation(async () => {
      const observation = {
        success: true,
        timestamp: new Date().toISOString(),
        display: 0,
        width: 1280,
        height: 720,
        screenshotPath: 'test-screenshot.png',
        imageFixtureFallbackUsed: true,
      };
      ctx.computerVisionConnector.lastObservation = observation;
      return observation;
    });

    // Reset loop count triggers
    desktopConnector.resetActionCount();

    // Trigger a fresh mockup vision observation to satisfy freshness constraints (max age 15s)
    await ctx.computerVisionConnector.captureScreen('software-engineer');

    // Setup VoiceManager with continuous listening enabled
    audioEngine = new MockAudioEngine();
    logger = createLogger('test-voice', 'silent');
    voiceManager = new VoiceManager(audioEngine, logger, {
      sttConfidenceThreshold: 0.6,
      wakeWordSensitivity: 0.5,
      continuousListening: true,
      continuousTimeoutMs: 200, // Short timeout for tests
      eventBus: ctx.eventBus,
    });
    await voiceManager.init();
  });

  describe('Global Input Override & Fail-Closed', () => {
    it('should reject desktop control immediately if override hook is not active (fail-closed policy)', async () => {
      // Set status to failed
      vi.spyOn(overrideHookConnector, 'getStatus').mockReturnValue('failed');

      const result = await desktopConnector.moveMouse('software-engineer', 100, 100);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('Global input override safety hook is not active');
    });

    it('should allow desktop control if override hook is active', async () => {
      vi.spyOn(overrideHookConnector, 'getStatus').mockReturnValue('active');
      vi.spyOn(ctx.gatekeeper, 'approvalPrompt').mockResolvedValue(true);

      const result = await desktopConnector.moveMouse('software-engineer', 100, 100);
      expect(result.status).toBe('SUCCESS');
    });

    it('should trigger emergency stop when a genuine hardware override event is detected', async () => {
      vi.spyOn(overrideHookConnector, 'getStatus').mockReturnValue('active');
      vi.spyOn(ctx.gatekeeper, 'approvalPrompt').mockResolvedValue(true);

      // Simulate a hardware override event
      overrideHookConnector.simulateOverrideEvent('KEY:27'); // Escape key

      const result = await desktopConnector.moveMouse('software-engineer', 100, 100);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('Action blocked due to active emergency-stop condition');
    });
  });

  describe('Voice-Triggered Stop vs. Authorization Gating', () => {
    it('should trigger emergency stop when "stop" is spoken, interrupting Jarvis', async () => {
      vi.spyOn(overrideHookConnector, 'getStatus').mockReturnValue('active');
      vi.spyOn(ctx.gatekeeper, 'approvalPrompt').mockResolvedValue(true);

      let stopEmitted = false;
      voiceManager.on('stop', () => { stopEmitted = true; });

      audioEngine.simulateWakeWord();
      audioEngine.simulateTranscription('stop', 0.9);

      expect(stopEmitted).toBe(true);

      // Verify desktop actions are now blocked
      const result = await desktopConnector.moveMouse('software-engineer', 100, 100);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('Action blocked due to active emergency-stop condition');
    });

    it('should trigger emergency stop when "cancel" is spoken', async () => {
      vi.spyOn(overrideHookConnector, 'getStatus').mockReturnValue('active');
      vi.spyOn(ctx.gatekeeper, 'approvalPrompt').mockResolvedValue(true);

      let stopEmitted = false;
      voiceManager.on('stop', () => { stopEmitted = true; });

      audioEngine.simulateWakeWord();
      audioEngine.simulateTranscription('cancel', 0.9);

      expect(stopEmitted).toBe(true);

      const result = await desktopConnector.moveMouse('software-engineer', 100, 100);
      expect(result.status).toBe('DENIED');
    });

    it('should re-verify that voice commands cannot authorize pending gatekeeper approvals', async () => {
      vi.spyOn(overrideHookConnector, 'getStatus').mockReturnValue('active');

      // Mock a pending unattended approval task
      vi.spyOn(ctx.gatekeeper, 'authorize').mockImplementation(async (req: any) => {
        return {
          granted: false,
          correlationId: 'pending-id',
          denialReason: 'pending-approval',
        };
      });

      // Attempt to authorize via voice transcription - should NOT modify approval status to granted
      audioEngine.simulateWakeWord();
      audioEngine.simulateTranscription('approve task', 0.95);

      const result = await desktopConnector.moveMouse('software-engineer', 100, 100);
      expect(result.status).toBe('CONFIRMATION_REQUIRED');
    });
  });

  describe('Turn-Taking Continuous Voice Loop', () => {
    it('should allow follow-up voice command without wake word if continuous listening is enabled', async () => {
      let commandCount = 0;
      let lastCommand = '';
      voiceManager.on('command', (cmd) => {
        commandCount++;
        lastCommand = cmd;
      });

      // Turn 1: Requires Wake Word
      audioEngine.simulateWakeWord();
      audioEngine.simulateTranscription('first command', 0.9);
      expect(commandCount).toBe(1);
      expect(lastCommand).toBe('first command');

      // Simulate Jarvis response finished speaking - triggers continuous turn-taking
      await voiceManager.speak('Okay, done');

      // Turn 2: Spoken immediately WITHOUT wake word
      audioEngine.simulateTranscription('second command', 0.9);
      expect(commandCount).toBe(2);
      expect(lastCommand).toBe('second command');
    });

    it('should transition back to wake word requirement after turn-taking timeout', async () => {
      let commandCount = 0;
      voiceManager.on('command', () => { commandCount++; });

      audioEngine.simulateWakeWord();
      audioEngine.simulateTranscription('first command', 0.9);
      expect(commandCount).toBe(1);

      await voiceManager.speak('Okay');

      // Wait for continuous turn-taking timeout (200ms)
      await new Promise(resolve => setTimeout(resolve, 300));

      // Attempt command without wake word - should be ignored
      audioEngine.simulateTranscription('second command', 0.9);
      expect(commandCount).toBe(1);
    });
  });

  describe('PowerShell Input Hook Low-Level Injected Flag Checks', () => {
    it('should NOT trigger override for synthetic/injected input events', async () => {
      if (process.platform !== 'win32') return;

      const testHook = new OverrideHookConnector({
        eventBus: ctx.eventBus,
        logger,
      });

      await testHook.startInTestMode();

      let overrideFired = false;
      testHook.on('override', () => { overrideFired = true; });

      // Send injected/synthetic Escape key (vkCode 27, flags = 0x10)
      testHook.sendTestKey(27, 0x10);

      // Send injected/synthetic Mouse click (flags = 0x01)
      testHook.sendTestMouse(100, 100, 0x01, false);

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(overrideFired).toBe(false);

      await testHook.stop();
    });

    it('should trigger override for genuine keyboard and mouse input events', async () => {
      if (process.platform !== 'win32') return;

      const testHook = new OverrideHookConnector({
        eventBus: ctx.eventBus,
        logger,
      });

      await testHook.startInTestMode();

      let overrideEvents: string[] = [];
      testHook.on('override', (evt) => { overrideEvents.push(evt); });

      // Send genuine Escape key (vkCode 27, flags = 0x00)
      testHook.sendTestKey(27, 0x00);

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(overrideEvents).toContain('OVERRIDE:KEY:27');

      // Send genuine mouse movement (delta > threshold 10)
      testHook.sendTestMouse(100, 100, 0x00, true);
      await new Promise(resolve => setTimeout(resolve, 100));

      testHook.sendTestMouse(120, 100, 0x00, true);
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(overrideEvents.some(evt => evt.includes('MOUSE_MOVE'))).toBe(true);

      await testHook.stop();
    });
  });
});
