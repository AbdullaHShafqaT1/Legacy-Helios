import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComputerVisionConnector } from '../../connectors/vision/ComputerVisionConnector.js';
import { bootstrap } from '../src/bootstrap.js';
import { denyAllPrompt } from '../src/permissions/gatekeeper.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Computer Vision Layer E2E Integration tests', () => {
  let ctx: any;
  let visionConnector: ComputerVisionConnector;

  beforeEach(() => {
    ctx = bootstrap(denyAllPrompt, 'test-vision', false);
    visionConnector = ctx.computerVisionConnector;
  });

  it('should list active screens and succeed with capture screen', async () => {
    // Under headless CI runners, screen capture GDI API will fallback to the desktop_screenshot.png fixture
    const observation = await visionConnector.captureScreen('researcher', 0);
    expect(observation.success).toBe(true);
    expect(observation.display).toBe(0);
    expect(observation.screenshotPath).toBeDefined();
    expect(fs.existsSync(observation.screenshotPath!)).toBe(true);
  });

  it('should propagate failure on invalid display index', async () => {
    const observation = await visionConnector.captureScreen('researcher', 999);
    // Since display 999 is invalid, it will fail the powershell script, and because 999 isn't a matched mock fixture display, it will report failure
    expect(observation.success).toBe(false);
    expect(observation.error).toBeDefined();
  });

  it('should perform screen analysis with multimodal prompt routing', async () => {
    // Mock the modelRouter.route to return a fake visual description
    const routeSpy = vi.spyOn(ctx.modelRouter, 'route').mockResolvedValue({
      text: 'Successfully processed screenshot.',
    });

    const description = await visionConnector.analyzeScreen('researcher', 'Identify visible windows.');
    expect(description).toBe('Successfully processed screenshot.');
    expect(routeSpy).toHaveBeenCalledWith('vision', expect.objectContaining({
      description: 'Identify visible windows.',
      image: expect.objectContaining({
        mediaType: 'image/png',
      }),
    }));
  });

  it('should enforce strict security boundary (Forbidden Phase 10 control methods)', () => {
    // Assert that the connector does NOT expose any coordinate clicking or mouse automation methods
    const methods = Object.getOwnPropertyNames(ComputerVisionConnector.prototype);
    
    expect(methods).not.toContain('click');
    expect(methods).not.toContain('moveMouse');
    expect(methods).not.toContain('typeText');
    expect(methods).not.toContain('pressKey');
    expect(methods).not.toContain('drag');
    expect(methods).not.toContain('scroll');
  });
});
