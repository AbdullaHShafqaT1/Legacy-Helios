import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DesktopOperatorAgent } from '../../agents/desktop-operator/DesktopOperatorAgent.js';
import { ModelRouter } from '../src/router/modelRouter.js';
import { DesktopConnector } from '../../connectors/desktop/DesktopConnector.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { createLogger } from '../src/lib/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DesktopOperatorAgent Closed-Loop Visual Feedback & Verification', () => {
  let logger: any;
  let mockModelRouter: any;
  let mockDesktopConnector: any;
  let mockMemoryManager: any;
  let agent: DesktopOperatorAgent;
  let tempDir: string;
  let testScreenshotPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-operator-test-'));
    testScreenshotPath = path.join(tempDir, 'screen.png');
    // Write a dummy 1x1 png file so fs.existsSync passes
    fs.writeFileSync(testScreenshotPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

    logger = createLogger('desktop-operator-test', 'silent');

    mockModelRouter = {
      route: vi.fn(),
    };

    mockDesktopConnector = {
      captureScreen: vi.fn().mockResolvedValue({
        success: true,
        timestamp: new Date().toISOString(),
        display: 0,
        width: 1920,
        height: 1080,
        screenshotPath: testScreenshotPath,
        imageFixtureFallbackUsed: true,
      }),
      resetActionCount: vi.fn(),
      moveMouse: vi.fn().mockResolvedValue({ status: 'SUCCESS', message: 'Moved mouse' }),
      click: vi.fn().mockResolvedValue({ status: 'SUCCESS', message: 'Reliable click executed' }),
      focusWindow: vi.fn().mockResolvedValue({ status: 'SUCCESS', message: 'Focused chrome' }),
      hotkey: vi.fn().mockResolvedValue({ status: 'SUCCESS', message: 'Sent hotkey' }),
      typeText: vi.fn().mockResolvedValue({ status: 'SUCCESS', message: 'Typed text' }),
      pressKey: vi.fn().mockResolvedValue({ status: 'SUCCESS', message: 'Pressed key' }),
    };

    mockMemoryManager = {
      store: vi.fn().mockResolvedValue('mock-memory-id'),
      query: vi.fn().mockResolvedValue([]),
    };

    agent = new DesktopOperatorAgent(
      mockModelRouter as any,
      mockDesktopConnector as any,
      mockMemoryManager as any,
      logger
    );
  });

  it('should execute full closed-loop visual click verification sequence successfully', async () => {
    // 1. Task plan reasoning response
    mockModelRouter.route.mockImplementation(async (taskType: string, ctx: any) => {
      if (taskType === 'reasoning') {
        return {
          text: JSON.stringify({
            actions: [
              { action: 'click_visual', target: 'first recommended video thumbnail', post_click_wait_ms: 10 },
            ],
          }),
        };
      }
      if (taskType === 'vision') {
        const desc = ctx.description;
        if (desc.includes('locate the center coordinates')) {
          return { text: '{"x": 640, "y": 360}' };
        }
        if (desc.includes('interim screenshot')) {
          return {
            text: JSON.stringify({
              confirmed: true,
              hoverStateDetected: true,
              needsAdjustment: false,
              adjustedCoordinates: null,
              reason: 'Thumbnail preview expansion detected',
            }),
          };
        }
        if (desc.includes('transitioned to the YouTube video player')) {
          return {
            text: JSON.stringify({
              transitioned: true,
              confidence: 0.95,
              indicators: ['playback UI', 'scrub bar', 'watch?v= in URL'],
              reason: 'Video player viewport active',
            }),
          };
        }
      }
      return { text: '{}' };
    });

    const result = await agent.process({
      taskId: 'test-task-1',
      description: 'Click the first recommended video on YouTube',
    });

    expect(result.status).toBe('completed');
    expect(mockDesktopConnector.moveMouse).toHaveBeenCalledWith('desktop-operator', 1229, 389);
    expect(mockDesktopConnector.click).toHaveBeenCalledWith('desktop-operator', 1229, 389);
    expect(mockMemoryManager.store).toHaveBeenCalled();
  });

  it('should adjust coordinates when interim hover confirmation suggests fine adjustment', async () => {
    mockModelRouter.route.mockImplementation(async (taskType: string, ctx: any) => {
      if (taskType === 'reasoning') {
        return {
          text: JSON.stringify({
            actions: [
              { action: 'click_visual', target: 'first recommended video thumbnail', post_click_wait_ms: 10 },
            ],
          }),
        };
      }
      if (taskType === 'vision') {
        const desc = ctx.description;
        if (desc.includes('locate the center coordinates')) {
          return { text: '{"x": 500, "y": 300}' };
        }
        if (desc.includes('interim screenshot')) {
          return {
            text: JSON.stringify({
              confirmed: true,
              hoverStateDetected: false,
              needsAdjustment: true,
              adjustedCoordinates: { x: 980, y: 340 },
              reason: 'Center cursor closer to play button overlay',
            }),
          };
        }
        if (desc.includes('transitioned to the YouTube video player')) {
          return {
            text: JSON.stringify({
              transitioned: true,
              confidence: 0.98,
              indicators: ['watch?v='],
              reason: 'Watch page loaded',
            }),
          };
        }
      }
      return { text: '{}' };
    });

    const result = await agent.process({
      taskId: 'test-task-2',
      description: 'Click video with hover adjustment',
    });

    expect(result.status).toBe('completed');
    // First moved to initial coords (500/1000*1920 = 960, 300/1000*1080 = 324), then re-glided to adjusted coords
    expect(mockDesktopConnector.moveMouse).toHaveBeenCalledWith('desktop-operator', 960, 324);
    expect(mockDesktopConnector.moveMouse).toHaveBeenCalledWith('desktop-operator', 980, 340);
    // Reliable click fired on adjusted coords
    expect(mockDesktopConnector.click).toHaveBeenCalledWith('desktop-operator', 980, 340);
  });

  it('should retry click and re-target when post-click verification initially fails', async () => {
    let postClickCallCount = 0;

    mockModelRouter.route.mockImplementation(async (taskType: string, ctx: any) => {
      if (taskType === 'reasoning') {
        return {
          text: JSON.stringify({
            actions: [
              { action: 'click_visual', target: 'first recommended video thumbnail', max_retries: 2, post_click_wait_ms: 10 },
            ],
          }),
        };
      }
      if (taskType === 'vision') {
        const desc = ctx.description;
        if (desc.includes('locate the center coordinates')) {
          return { text: '{"x": 700, "y": 400}' };
        }
        if (desc.includes('interim screenshot')) {
          return { text: '{"confirmed": true, "hoverStateDetected": true}' };
        }
        if (desc.includes('transitioned to the YouTube video player')) {
          postClickCallCount++;
          if (postClickCallCount === 1) {
            // First attempt: click missed or dropped by Chrome
            return {
              text: JSON.stringify({
                transitioned: false,
                confidence: 0.1,
                indicators: [],
                reason: 'Still on YouTube home feed, no video playback UI detected',
              }),
            };
          } else {
            // Second attempt (retry): successfully opened
            return {
              text: JSON.stringify({
                transitioned: true,
                confidence: 0.92,
                indicators: ['video player UI', 'progress bar'],
                reason: 'Video player loaded',
              }),
            };
          }
        }
      }
      return { text: '{}' };
    });

    const result = await agent.process({
      taskId: 'test-task-3',
      description: 'Click video with retry',
    });

    expect(result.status).toBe('completed');
    expect(postClickCallCount).toBe(2);
    // Click was executed twice due to retry
    expect(mockDesktopConnector.click).toHaveBeenCalledTimes(2);
  });

  it('should fail gracefully if post-click verification fails across all retries', async () => {
    mockModelRouter.route.mockImplementation(async (taskType: string, ctx: any) => {
      if (taskType === 'reasoning') {
        return {
          text: JSON.stringify({
            actions: [
              { action: 'click_visual', target: 'first recommended video thumbnail', max_retries: 1, post_click_wait_ms: 10 },
            ],
          }),
        };
      }
      if (taskType === 'vision') {
        const desc = ctx.description;
        if (desc.includes('locate the center coordinates')) {
          return { text: '{"x": 600, "y": 300}' };
        }
        if (desc.includes('interim screenshot')) {
          return { text: '{"confirmed": true}' };
        }
        if (desc.includes('transitioned to the YouTube video player')) {
          return {
            text: JSON.stringify({
              transitioned: false,
              confidence: 0.05,
              indicators: [],
              reason: 'Page unresponsive',
            }),
          };
        }
      }
      return { text: '{}' };
    });

    const result = await agent.process({
      taskId: 'test-task-4',
      description: 'Click video with persistent transition failure',
    });

    expect(result.status).toBe('failed');
    expect(result.explanation).toContain('Post-click verification failed');
    expect(mockDesktopConnector.click).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('should handle vision model error gracefully and proceed with layout heuristic', async () => {
    mockModelRouter.route.mockImplementation(async (taskType: string) => {
      if (taskType === 'reasoning') {
        return {
          text: JSON.stringify({
            actions: [
              { action: 'click_visual', target: 'first recommended video thumbnail', post_click_wait_ms: 10 },
            ],
          }),
        };
      }
      if (taskType === 'vision') {
        throw new Error('Vision model temporarily offline');
      }
      return { text: '{}' };
    });

    const result = await agent.process({
      taskId: 'test-task-5',
      description: 'Click video with vision error fallback',
    });

    expect(result.status).toBe('completed');
    // Default heuristic at 1920x1080 (0.28*1920 = 538, 0.26*1080 = 281)
    expect(mockDesktopConnector.click).toHaveBeenCalledWith('desktop-operator', 538, 281);
  });

  it('should skip hover and post-click verification when high-confidence direct coordinates are supplied', async () => {
    mockModelRouter.route.mockImplementation(async (taskType: string) => {
      if (taskType === 'reasoning') {
        return {
          text: JSON.stringify({
            actions: [
              {
                action: 'click_visual',
                x: 1200,
                y: 800,
                confidence: 0.95,
                skip_hover: true,
                skip_verification: true,
              },
            ],
          }),
        };
      }
      return { text: '{}' };
    });

    const result = await agent.process({
      taskId: 'test-task-6',
      description: 'Click directly at 1200, 800 with high confidence',
    });

    expect(result.status).toBe('completed');
    expect(mockDesktopConnector.moveMouse).toHaveBeenCalledWith('desktop-operator', 1200, 800);
    expect(mockDesktopConnector.click).toHaveBeenCalledWith('desktop-operator', 1200, 800);
  });

  it('should respect custom constructor options for hover and post-click delays', () => {
    const fastAgent = new DesktopOperatorAgent(
      mockModelRouter as any,
      mockDesktopConnector as any,
      mockMemoryManager as any,
      logger,
      undefined,
      undefined,
      { hoverDwellMs: 50, postClickWaitMs: 100 }
    );
    expect((fastAgent as any).defaultHoverDwellMs).toBe(50);
    expect((fastAgent as any).defaultPostClickWaitMs).toBe(100);
  });
});

