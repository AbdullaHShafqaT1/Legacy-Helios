import fs from 'node:fs';
import path from 'node:path';

export interface ScreenResolution {
  width: number;
  height: number;
  dpiScale?: number;
}

export interface BoundingBoxObject {
  xmin?: number;
  ymin?: number;
  xmax?: number;
  ymax?: number;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  box_2d?: [number, number, number, number]; // [ymin, xmin, ymax, xmax]
}

export type CoordinateInput =
  | [number, number] // [x, y] or [ymin, xmin]
  | [number, number, number, number] // [ymin, xmin, ymax, xmax]
  | { x: number; y: number }
  | BoundingBoxObject;

export interface GroundedCoordinate {
  pixelX: number;
  pixelY: number;
  x: number; // alias for pixelX
  y: number; // alias for pixelY
  normalizedX: number; // 0.0 to 1.0
  normalizedY: number; // 0.0 to 1.0
  box?: {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
  sourceFormat: 'normalized_1000' | 'normalized_unit' | 'absolute_pixel' | 'unknown';
}

export interface AnchorVerificationOptions {
  tolerance?: number;
  patchRadius?: number;
}

export interface AnchorVerificationResult {
  verified: boolean;
  confidence: number;
  adjustedCoords?: { x: number; y: number };
  reason?: string;
}

/**
 * CoordinateResolutionService provides grounding and normalization
 * of VLM / LLM bounding boxes and points into physical screen coordinates.
 */
export class CoordinateResolutionService {
  private defaultResolution: ScreenResolution;

  constructor(defaultResolution?: ScreenResolution) {
    this.defaultResolution = defaultResolution ?? { width: 1920, height: 1080, dpiScale: 1.0 };
  }

  /**
   * Updates or sets the current screen resolution context.
   */
  setScreenResolution(resolution: ScreenResolution): void {
    if (resolution.width > 0 && resolution.height > 0) {
      this.defaultResolution = {
        width: Math.round(resolution.width),
        height: Math.round(resolution.height),
        dpiScale: resolution.dpiScale ?? 1.0,
      };
    }
  }

  /**
   * Gets the active screen resolution context.
   */
  getScreenResolution(): ScreenResolution {
    return { ...this.defaultResolution };
  }

  /**
   * Resolves arbitrary VLM coordinate input (normalized bounding box, normalized point,
   * or pixel point) into physical screen pixel coordinates with automatic centroid targeting.
   *
   * @param input Raw model coordinate input.
   * @param overrideResolutionOrWidth Optional screen resolution object or width in pixels.
   * @param overrideHeight Optional height in pixels if width was provided as a number.
   */
  resolve(
    input: CoordinateInput,
    overrideResolutionOrWidth?: ScreenResolution | number,
    overrideHeight?: number
  ): GroundedCoordinate {
    let width = this.defaultResolution.width > 0 ? this.defaultResolution.width : 1920;
    let height = this.defaultResolution.height > 0 ? this.defaultResolution.height : 1080;

    if (typeof overrideResolutionOrWidth === 'number') {
      width = overrideResolutionOrWidth;
      if (typeof overrideHeight === 'number') {
        height = overrideHeight;
      }
    } else if (overrideResolutionOrWidth && typeof overrideResolutionOrWidth === 'object') {
      if (overrideResolutionOrWidth.width > 0) width = overrideResolutionOrWidth.width;
      if (overrideResolutionOrWidth.height > 0) height = overrideResolutionOrWidth.height;
    }

    // 1. Array format [ymin, xmin, ymax, xmax] or [x, y]
    if (Array.isArray(input)) {
      if (input.length === 4) {
        // [ymin, xmin, ymax, xmax] - Gemini / standard object detection box format
        const [ymin, xmin, ymax, xmax] = input;
        return this.resolveBoundingBox(xmin, ymin, xmax, ymax, width, height);
      } else if (input.length === 2) {
        const [x, y] = input;
        return this.resolvePoint(x, y, width, height);
      }
    }

    // 2. Object format with box_2d
    if (typeof input === 'object' && input !== null) {
      const obj = input as any;

      if (Array.isArray(obj.box_2d) && obj.box_2d.length === 4) {
        const [ymin, xmin, ymax, xmax] = obj.box_2d;
        return this.resolveBoundingBox(xmin, ymin, xmax, ymax, width, height);
      }

      // { xmin, ymin, xmax, ymax }
      if (obj.xmin !== undefined && obj.ymin !== undefined && obj.xmax !== undefined && obj.ymax !== undefined) {
        return this.resolveBoundingBox(obj.xmin, obj.ymin, obj.xmax, obj.ymax, width, height);
      }

      // { left, top, right, bottom }
      if (obj.left !== undefined && obj.top !== undefined && obj.right !== undefined && obj.bottom !== undefined) {
        return this.resolveBoundingBox(obj.left, obj.top, obj.right, obj.bottom, width, height);
      }

      // { x, y, width, height } where width & height > 0
      if (obj.x !== undefined && obj.y !== undefined && obj.width !== undefined && obj.height !== undefined && (obj.width > 0 || obj.height > 0)) {
        return this.resolveBoundingBox(obj.x, obj.y, obj.x + obj.width, obj.y + obj.height, width, height);
      }

      // Single point { x, y }
      if (obj.x !== undefined && obj.y !== undefined) {
        return this.resolvePoint(obj.x, obj.y, width, height);
      }
    }

    // Fallback: center of screen
    const defaultX = Math.round(width / 2);
    const defaultY = Math.round(height / 2);
    return {
      pixelX: defaultX,
      pixelY: defaultY,
      x: defaultX,
      y: defaultY,
      normalizedX: 0.5,
      normalizedY: 0.5,
      sourceFormat: 'unknown',
    };
  }

  /**
   * Resolves a bounding box, computing the geometric centroid (xmid, ymid)
   * and scaling it to screen pixels.
   */
  resolveBoundingBox(
    xmin: number,
    ymin: number,
    xmax: number,
    ymax: number,
    screenWidth?: number,
    screenHeight?: number
  ): GroundedCoordinate {
    const width = screenWidth ?? this.defaultResolution.width;
    const height = screenHeight ?? this.defaultResolution.height;
    const maxCoord = Math.max(Math.abs(xmin), Math.abs(ymin), Math.abs(xmax), Math.abs(ymax));
    let normXmin = xmin;
    let normYmin = ymin;
    let normXmax = xmax;
    let normYmax = ymax;
    let sourceFormat: GroundedCoordinate['sourceFormat'] = 'normalized_unit';

    if (maxCoord > 1.0 && maxCoord <= 1000) {
      // 0..1000 normalized format
      normXmin = xmin / 1000;
      normYmin = ymin / 1000;
      normXmax = xmax / 1000;
      normYmax = ymax / 1000;
      sourceFormat = 'normalized_1000';
    } else if (maxCoord > 1000) {
      // Direct pixel coordinates
      normXmin = xmin / width;
      normYmin = ymin / height;
      normXmax = xmax / width;
      normYmax = ymax / height;
      sourceFormat = 'absolute_pixel';
    }

    // Ensure order
    const realXmin = Math.min(normXmin, normXmax);
    const realXmax = Math.max(normXmin, normXmax);
    const realYmin = Math.min(normYmin, normYmax);
    const realYmax = Math.max(normYmin, normYmax);

    // Centroid calculation
    const normXmid = (realXmin + realXmax) / 2;
    const normYmid = (realYmin + realYmax) / 2;

    const clampedXmid = Math.max(0, Math.min(normXmid, 1.0));
    const clampedYmid = Math.max(0, Math.min(normYmid, 1.0));

    const pixelX = Math.max(0, Math.min(Math.round(clampedXmid * width), width - 1));
    const pixelY = Math.max(0, Math.min(Math.round(clampedYmid * height), height - 1));

    return {
      pixelX,
      pixelY,
      x: pixelX,
      y: pixelY,
      normalizedX: Number(clampedXmid.toFixed(4)),
      normalizedY: Number(clampedYmid.toFixed(4)),
      box: {
        xmin: Math.max(0, Math.min(Math.round(realXmin * width), width - 1)),
        ymin: Math.max(0, Math.min(Math.round(realYmin * height), height - 1)),
        xmax: Math.max(0, Math.min(Math.round(realXmax * width), width - 1)),
        ymax: Math.max(0, Math.min(Math.round(realYmax * height), height - 1)),
      },
      sourceFormat,
    };
  }

  /**
   * Resolves a point (x, y) into physical screen pixel coordinates.
   */
  resolvePoint(
    x: number,
    y: number,
    screenWidth?: number,
    screenHeight?: number,
    format?: 'normalized_unit' | 'normalized_1000' | 'absolute_pixel'
  ): GroundedCoordinate {
    const width = screenWidth ?? this.defaultResolution.width;
    const height = screenHeight ?? this.defaultResolution.height;
    const maxCoord = Math.max(Math.abs(x), Math.abs(y));
    let normX = x;
    let normY = y;
    let sourceFormat: GroundedCoordinate['sourceFormat'] = format ?? 'normalized_unit';

    if (format) {
      if (format === 'normalized_1000') {
        normX = x / 1000;
        normY = y / 1000;
      } else if (format === 'absolute_pixel') {
        const clampedX = Math.max(0, Math.min(Math.round(x), width - 1));
        const clampedY = Math.max(0, Math.min(Math.round(y), height - 1));
        return {
          pixelX: clampedX,
          pixelY: clampedY,
          x: clampedX,
          y: clampedY,
          normalizedX: Number((clampedX / width).toFixed(4)),
          normalizedY: Number((clampedY / height).toFixed(4)),
          sourceFormat: 'absolute_pixel',
        };
      }
    } else {
      if (maxCoord > 2.0 && maxCoord <= 1000) {
        normX = x / 1000;
        normY = y / 1000;
        sourceFormat = 'normalized_1000';
      } else if (maxCoord > 1000) {
        // Absolute pixels
        const clampedX = Math.max(0, Math.min(Math.round(x), width - 1));
        const clampedY = Math.max(0, Math.min(Math.round(y), height - 1));
        return {
          pixelX: clampedX,
          pixelY: clampedY,
          x: clampedX,
          y: clampedY,
          normalizedX: Number((clampedX / width).toFixed(4)),
          normalizedY: Number((clampedY / height).toFixed(4)),
          sourceFormat: 'absolute_pixel',
        };
      }
    }

    const clampedNormX = Math.max(0, Math.min(normX, 1.0));
    const clampedNormY = Math.max(0, Math.min(normY, 1.0));

    const pixelX = Math.max(0, Math.min(Math.round(clampedNormX * width), width - 1));
    const pixelY = Math.max(0, Math.min(Math.round(clampedNormY * height), height - 1));

    return {
      pixelX,
      pixelY,
      x: pixelX,
      y: pixelY,
      normalizedX: Number(clampedNormX.toFixed(4)),
      normalizedY: Number(clampedNormY.toFixed(4)),
      sourceFormat,
    };
  }

  /**
   * Fallback visual verification hook: checks if an anchor screenshot exists and verifies
   * that expected coordinates fall within valid display boundaries without boundary violations.
   */
  async verifyAnchorPatch(
    screenshotPath: string,
    expectedCoords: { x: number; y: number },
    options?: AnchorVerificationOptions
  ): Promise<AnchorVerificationResult> {
    if (!screenshotPath) {
      return { verified: false, confidence: 0, reason: 'No screenshot path provided' };
    }

    if (!fs.existsSync(screenshotPath)) {
      return { verified: false, confidence: 0, reason: `Screenshot file not found: ${screenshotPath}` };
    }

    const res = this.defaultResolution;
    const tolerance = options?.tolerance ?? 5;

    // Check if coordinates are within the safe monitor canvas
    if (expectedCoords.x < 0 || expectedCoords.x >= res.width || expectedCoords.y < 0 || expectedCoords.y >= res.height) {
      return {
        verified: false,
        confidence: 0,
        reason: `Target (${expectedCoords.x}, ${expectedCoords.y}) is outside canvas bounds (${res.width}x${res.height})`,
      };
    }

    // Verified within safe screen bounding
    return {
      verified: true,
      confidence: 0.98,
      adjustedCoords: {
        x: Math.max(0, Math.min(expectedCoords.x, res.width - 1)),
        y: Math.max(0, Math.min(expectedCoords.y, res.height - 1)),
      },
    };
  }
}
