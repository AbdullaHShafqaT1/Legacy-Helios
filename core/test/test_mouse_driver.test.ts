import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { CoordinateResolutionService } from '../src/vision/CoordinateResolutionService.js';
import { DesktopConnector } from '../../connectors/desktop/DesktopConnector.js';

describe('CoordinateResolutionService', () => {
  let resolver: CoordinateResolutionService;

  beforeEach(() => {
    resolver = new CoordinateResolutionService({ width: 2560, height: 1440, dpiScale: 1.5 });
  });

  it('should accurately resolve [0.0, 1.0] normalized unit coordinates', () => {
    const res = resolver.resolvePoint(0.5, 0.5, 2560, 1440);
    expect(res.pixelX).toBe(1280);
    expect(res.pixelY).toBe(720);
    expect(res.x).toBe(1280);
    expect(res.y).toBe(720);
    expect(res.sourceFormat).toBe('normalized_unit');
  });

  it('should accurately resolve [0, 1000] VLM normalized coordinates', () => {
    // 640 in 1000 scale on 1920 width = (640/1000)*1920 = 1228.8 -> 1229
    // 360 in 1000 scale on 1080 height = (360/1000)*1080 = 388.8 -> 389
    const res = resolver.resolvePoint(640, 360, 1920, 1080);
    expect(res.pixelX).toBe(1229);
    expect(res.pixelY).toBe(389);
    expect(res.sourceFormat).toBe('normalized_1000');
  });

  it('should compute geometric centroid for [ymin, xmin, ymax, xmax] bounding boxes', () => {
    // Box from [100, 200] to [300, 400] in 1000-scale
    // xmin = 200, xmax = 400 -> mid = 300
    // ymin = 100, ymax = 300 -> mid = 200
    // At 2560x1440:
    // x = 0.3 * 2560 = 768
    // y = 0.2 * 1440 = 288
    const res = resolver.resolve([100, 200, 300, 400], 2560, 1440);
    expect(res.pixelX).toBe(768);
    expect(res.pixelY).toBe(288);
    expect(res.box).toBeDefined();
    expect(res.box?.xmin).toBe(512); // 0.2 * 2560
    expect(res.box?.xmax).toBe(1024); // 0.4 * 2560
  });

  it('should compute geometric centroid for object format bounding boxes', () => {
    const res = resolver.resolve({
      xmin: 0.1,
      ymin: 0.2,
      xmax: 0.3,
      ymax: 0.4,
    }, 1000, 1000);
    // xmid = 0.2 -> 200
    // ymid = 0.3 -> 300
    expect(res.pixelX).toBe(200);
    expect(res.pixelY).toBe(300);
  });

  it('should safely clamp out-of-bounds coordinates to screen boundaries', () => {
    const resHigh = resolver.resolvePoint(1.5, 1.5, 1920, 1080, 'normalized_unit');
    expect(resHigh.pixelX).toBe(1919);
    expect(resHigh.pixelY).toBe(1079);

    const resLow = resolver.resolvePoint(-0.5, -0.5, 1920, 1080);
    expect(resLow.pixelX).toBe(0);
    expect(resLow.pixelY).toBe(0);
  });

  it('should provide lightweight anchor verification hook', async () => {
    const validFile = path.resolve(process.cwd(), 'package.json');
    const result = await resolver.verifyAnchorPatch(validFile, { x: 500, y: 500 });
    expect(result).toBeDefined();
    expect(result.verified).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.9);

    const missingResult = await resolver.verifyAnchorPatch('nonexistent_image.png', { x: 500, y: 500 });
    expect(missingResult.verified).toBe(false);
  });
});

describe('DesktopConnector Single-Purpose Mouse Tools', () => {
  let connector: DesktopConnector;
  let mockGatekeeper: any;
  let mockAuditLog: any;
  let mockVision: any;
  let mockOverrideHook: any;
  let mockLogger: any;

  beforeEach(() => {
    mockGatekeeper = {
      authorize: vi.fn().mockResolvedValue({ granted: true, correlationId: 'corr-123' }),
    };
    mockAuditLog = {
      recordOutcome: vi.fn(),
    };
    mockVision = {
      lastObservation: {
        timestamp: new Date().toISOString(),
        width: 2560,
        height: 1440,
        screenshotPath: '/tmp/test.png',
      },
      captureScreen: vi.fn().mockResolvedValue({ success: true, screenshotPath: '/tmp/test.png' }),
    };
    mockOverrideHook = {
      getStatus: vi.fn().mockReturnValue('active'),
    };
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    connector = new DesktopConnector({
      gatekeeper: mockGatekeeper,
      auditLog: mockAuditLog,
      visionConnector: mockVision,
      overrideHookConnector: mockOverrideHook,
      logger: mockLogger,
    });
  });

  it('mouseClick should return structured JSON feedback with executed_at and timestamp', async () => {
    vi.spyOn(connector as any, 'executeScript').mockResolvedValue({
      status: 'SUCCESS',
      executedAt: [500, 600],
      timestamp: '2026-09-12T00:00:00.000Z',
      displayInfo: { width: 2560, height: 1440, dpi: 144, scalePercent: 150 },
    });

    const result = await connector.mouseClick('software-engineer', 500, 600, 'single');
    expect(result.status).toBe('SUCCESS');
    expect(result.executedAt).toEqual([500, 600]);
    expect(result.timestamp).toBe('2026-09-12T00:00:00.000Z');
    expect(result.displayInfo?.scalePercent).toBe(150);
  });

  it('mouseMove should return structured JSON feedback', async () => {
    vi.spyOn(connector as any, 'executeScript').mockResolvedValue({
      status: 'SUCCESS',
      executedAt: [800, 450],
      timestamp: '2026-09-12T00:00:01.000Z',
      displayInfo: { width: 2560, height: 1440 },
    });

    const result = await connector.mouseMove('software-engineer', 800, 450, true);
    expect(result.status).toBe('SUCCESS');
    expect(result.executedAt).toEqual([800, 450]);
  });

  it('mouseDrag should validate start and end coordinates and return structured feedback', async () => {
    vi.spyOn(connector as any, 'executeScript').mockResolvedValue({
      status: 'SUCCESS',
      executedAt: [700, 700],
      timestamp: '2026-09-12T00:00:02.000Z',
    });

    const result = await connector.mouseDrag('software-engineer', 200, 200, 700, 700);
    expect(result.status).toBe('SUCCESS');
    expect(result.executedAt).toEqual([700, 700]);
  });

  it('mouseScroll should execute and return structured feedback', async () => {
    vi.spyOn(connector as any, 'executeScript').mockResolvedValue({
      status: 'SUCCESS',
      executedAt: [500, 500],
      timestamp: '2026-09-12T00:00:03.000Z',
    });

    const result = await connector.mouseScroll('software-engineer', 'down', 5);
    expect(result.status).toBe('SUCCESS');
  });

  it('should reject invalid coordinates (negative dimensions)', async () => {
    const result = await connector.mouseClick('software-engineer', -10, 500);
    expect(result.status).toBe('DENIED');
    expect(result.message).toContain('Negative dimensions are rejected');
  });

  it('should reject out-of-bounds coordinates against observation dimensions', async () => {
    const result = await connector.mouseClick('software-engineer', 3000, 500);
    expect(result.status).toBe('DENIED');
    expect(result.message).toContain('out of display bounds');
  });
});
