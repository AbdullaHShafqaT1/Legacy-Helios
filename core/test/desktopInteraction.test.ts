import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DesktopConnector } from '../../connectors/desktop/DesktopConnector.js';
import { bootstrap } from '../src/bootstrap.js';
import { denyAllPrompt } from '../src/permissions/gatekeeper.js';
import { createLogger } from '../src/lib/logger.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Desktop Interaction E2E Integration and Safety tests', () => {
  let ctx: any;
  let desktopConnector: DesktopConnector;

  beforeEach(async () => {
    // Bootstrap without requiring real Claude model key checks
    ctx = bootstrap(denyAllPrompt, 'test-desktop', false);
    desktopConnector = ctx.desktopConnector;

    // Spy on the private executeScript method to prevent invoking real PowerShell subprocesses
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
  });

  describe('Coordinate Safety and Bounding Checks', () => {
    it('should accept valid screen coordinates inside active screen boundaries', async () => {
      // Mock the approval prompt to auto-approve
      vi.spyOn(ctx.gatekeeper, 'approvalPrompt').mockResolvedValue(true);

      const result = await desktopConnector.moveMouse('software-engineer', 100, 100);
      expect(result.status).toBe('SUCCESS');
      expect(result.screenshotPathBefore).toBeDefined();
    });

    it('should reject negative coordinates immediately', async () => {
      const result = await desktopConnector.click('software-engineer', -50, 100);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('Negative dimensions are rejected');
    });

    it('should reject coordinates exceeding active screen width or height resolution', async () => {
      const result = await desktopConnector.doubleClick('software-engineer', 9999, 100);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('out of display bounds');
    });

    it('should reject coordinates when visual screenshots are stale or absent', async () => {
      // Artificially clear last observation context
      ctx.computerVisionConnector.lastObservation = null;

      const result = await desktopConnector.rightClick('software-engineer', 100, 100);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('No desktop screenshot has been captured yet');
    });
  });

  describe('Permission Boundary and Role Authorization Checks', () => {
    it('should block actions if the role lacks allowed category permissions', async () => {
      const result = await desktopConnector.typeText('researcher', 'hello');
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('permission denied (not-permitted)');
    });

    it('should enforce y/N prompt confirmations for allowed mouse/keyboard events', async () => {
      // Since bootstrap is passed denyAllPrompt, the prompt will return false
      const result = await desktopConnector.click('software-engineer', 200, 200);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('permission denied (explicit)');
    });

    it('should transition to CONFIRMATION_REQUIRED in unattended approval pending states', async () => {
      // Mock gatekeeper to report unattended pending-approval queue states
      vi.spyOn(ctx.gatekeeper, 'authorize').mockResolvedValue({
        granted: false,
        correlationId: 'test-pending-id',
        denialReason: 'pending-approval',
      });

      const result = await desktopConnector.moveMouse('software-engineer', 300, 300);
      expect(result.status).toBe('CONFIRMATION_REQUIRED');
      expect(result.message).toBe('pending-approval');
    });
  });

  describe('Input Safety Limits and Redactions', () => {
    it('should enforce keyboard input sequence character limits', async () => {
      const longText = 'a'.repeat(1000);
      const result = await desktopConnector.typeText('software-engineer', longText);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('exceeds configured maximum limit');
    });

    it('should stop and reject actions when sequence count limit is exceeded (runaway loop protection)', async () => {
      // Mock the approval prompt to auto-approve
      vi.spyOn(ctx.gatekeeper, 'approvalPrompt').mockResolvedValue(true);

      // Execute maximum allowed sequence limits (default: 20)
      for (let i = 0; i < 20; i++) {
        const result = await desktopConnector.scroll('software-engineer', -100);
        expect(result.status).toBe('SUCCESS');
      }

      // Next scroll execution should trigger runaway prevention block
      const finalResult = await desktopConnector.scroll('software-engineer', -100);
      expect(finalResult.status).toBe('DENIED');
      expect(finalResult.message).toContain('Exceeded maximum allowed desktop actions');
    });

    it('should redact sensitive text inputs from audit logs', async () => {
      const recordSpy = vi.spyOn(ctx.auditLog, 'recordRequest');

      // Mock the high friction approval prompt to auto-approve
      vi.spyOn(ctx.gatekeeper, 'highFrictionPrompt').mockResolvedValue(true);

      await desktopConnector.typeText('software-engineer', 'SuperSecretPass123!');

      // Confirm typed text did not get recorded directly to audit request logs
      expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          text: '[TEXT: Length 19 chars]',
        }),
      }));
    });

    it('should block actions when emergency stop is active', async () => {
      vi.spyOn(ctx.gatekeeper, 'approvalPrompt').mockResolvedValue(true);

      // Emit emergency stop event to block actions
      ctx.eventBus.emit('queue:emergency-stop');

      const result = await desktopConnector.moveMouse('software-engineer', 100, 100);
      expect(result.status).toBe('DENIED');
      expect(result.message).toContain('active emergency-stop condition');
    });
  });
});
