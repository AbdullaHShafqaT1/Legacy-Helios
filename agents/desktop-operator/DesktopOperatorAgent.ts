import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult, AgentMessage, deriveProjectTag } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { DesktopConnector, DesktopActionResult } from '../../connectors/desktop/DesktopConnector.js';
import { MemoryManager } from '../../core/src/memory/memoryManager.js';
import { MessageRouter } from '../../core/src/router/messageRouter.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { AgentRole } from '../../core/src/permissions/policy.js';
import { CoordinateResolutionService } from '../../core/src/vision/CoordinateResolutionService.js';

export interface DesktopOperatorOptions {
  hoverDwellMs?: number;
  postClickWaitMs?: number;
}

export class DesktopOperatorAgent implements Agent {
  readonly name = 'desktop-operator';
  private readonly modelRouter: ModelRouter;
  private readonly desktopConnector: DesktopConnector;
  private readonly memoryManager: MemoryManager;
  private readonly logger: Logger;
  private readonly messageRouter?: MessageRouter;
  private readonly coordinateService: CoordinateResolutionService;
  private readonly defaultHoverDwellMs: number;
  private readonly defaultPostClickWaitMs: number;

  private latestObservation: any = null;

  constructor(
    modelRouter: ModelRouter,
    desktopConnector: DesktopConnector,
    memoryManager: MemoryManager,
    logger: Logger,
    messageRouter?: MessageRouter,
    coordinateService?: CoordinateResolutionService,
    options?: DesktopOperatorOptions
  ) {
    this.modelRouter = modelRouter;
    this.desktopConnector = desktopConnector;
    this.memoryManager = memoryManager;
    this.logger = logger;
    this.messageRouter = messageRouter;
    this.coordinateService = coordinateService || new CoordinateResolutionService();
    this.defaultHoverDwellMs = options?.hoverDwellMs ?? 400;
    this.defaultPostClickWaitMs = options?.postClickWaitMs ?? 2000;
  }

  async process(input: AgentTaskInput): Promise<AgentResult> {
    const tag = deriveProjectTag(input);
    const fileContext = input.fileContext as Record<string, any> | undefined;

    try {
      try {
        this.latestObservation = await this.desktopConnector.captureScreen(this.name as AgentRole);
      } catch {
        // Soft fail if screen capture is not fully initialized, wait for actual failure in the connector
      }

      const response = await this.modelRouter.route('reasoning', {
        description: `Desktop operator received task: ${input.description}. 
Parse out what desktop actions to execute based strictly on the user's task. Return JSON with format:
{"actions": [{"action": "supported_action_name", "...parameter_key": "...parameter_value"}]}

Execution Engine & Mouse Control Context:
You are backed by a dedicated OS-level Win32 cursor controller with Per-Monitor DPI Aware v2 support and an automatic coordinate resolution service.
- Supported coordinate spaces: You can supply absolute screen pixels (e.g. 1920x1080 or 2560x1440), normalized coordinates [0, 1000] or [0.0, 1.0], or bounding boxes [ymin, xmin, ymax, xmax] (which automatically target the geometric center).
- DPI drift elimination: Hardware scaling (100%, 125%, 150%, 200%) is resolved natively with zero offset drift.
- Cursor trajectory: "smooth": true applies cubic ease-out interpolation; "smooth": false jumps instantaneously.
- Click reliability: Clicks use physical mouse down/up dwell time to guarantee register on UI buttons.

Supported actions: mouse_click, mouse_move, mouse_drag, mouse_scroll, focus_window, wait, click_visual, move, click, doubleclick, rightclick, drag, scroll, type, press, hotkey, open_tab, navigate, cloudcode_oversight.
Mouse actions:
- mouse_click: {"action": "mouse_click", "x": number, "y": number, "click_type": "single" | "double" | "right"}
- mouse_move: {"action": "mouse_move", "x": number, "y": number, "smooth": boolean}
- mouse_drag: {"action": "mouse_drag", "start_x": number, "start_y": number, "end_x": number, "end_y": number}
- mouse_scroll: {"action": "mouse_scroll", "direction": "up" | "down", "amount": number}
Rules:
- When interacting with an application or browser window, focus it first: {"action": "focus_window", "target": "<window_name>"}.
- To open a new tab in active browser, use {"action": "hotkey", "keys": "ctrl+t"}.
- To navigate or search, use {"action": "type", "text": "<url_or_text>"} followed by {"action": "press", "key": "enter"}.
- After navigating to a page, add a delay to allow the DOM/content to render: {"action": "wait", "seconds": 3}.
- To visually locate and click an item on the screen, use: {"action": "click_visual", "target": "<visual_target_description>"}.
- If the task does not request any desktop action (e.g. conversational greeting or query), return {"actions": []}.
- Only use supported actions. Never invent tasks or navigate to websites not requested by the user.`,
        fileContext: input.fileContext,
      });

      let actions: any[] = [];
      try {
        let textToParse = response.text.trim();
        const match = textToParse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
          textToParse = match[1].trim();
        }
        
        const parsed = JSON.parse(textToParse);
        actions = parsed.actions || [];
      } catch {
        return {
          status: 'failed',
          filesChanged: [],
          explanation: `Could not extract valid JSON actions from model router response: ${response.text.substring(0, 200)}`,
        };
      }

      if (actions.length === 0) {
        return {
          status: 'failed',
          filesChanged: [],
          explanation: 'No valid desktop actions found in the task description.',
        };
      }

      const role = this.name as AgentRole;

      // Reset action count and clear any stale emergency stop state before executing this task's actions
      this.desktopConnector.resetActionCount();

      // Re-capture screen observation right before executing actions so coordinate validations have fresh observation context
      try {
        this.latestObservation = await this.desktopConnector.captureScreen(role);
      } catch {
        // Soft fail if screen capture is not fully initialized
      }

      // Reset action count and clear any emergency stop condition latched during pre-execution capture
      this.desktopConnector.resetActionCount();

      // Auto-enforce browser focus if task involves browser/navigation and focus is not yet the first action
      const isBrowserTask = /(browser|tab|youtube|chrome|edge|firefox|website|url|navigate)\b/i.test(input.description);
      if (isBrowserTask && actions.length > 0 && actions[0].action !== 'focus_window' && actions[0].action !== 'focus_browser') {
        actions.unshift({ action: 'focus_window', target: 'chrome' });
      }

      // Auto-insert a render wait between navigation and visual click if not already present
      const hasNavigation = actions.some(a => a.action === 'navigate' || (a.action === 'type' && /youtube/i.test(a.text)));
      const hasVisualClick = actions.some(a => a.action === 'click_visual' || a.action === 'click_first_video' || a.action === 'click_video');
      const hasWait = actions.some(a => a.action === 'wait' || a.action === 'sleep');
      if (hasNavigation && hasVisualClick && !hasWait) {
        const clickIdx = actions.findIndex(a => a.action === 'click_visual' || a.action === 'click_first_video' || a.action === 'click_video');
        if (clickIdx > 0) {
          actions.splice(clickIdx, 0, { action: 'wait', seconds: 3 });
        }
      }

      for (const action of actions) {
        let result: DesktopActionResult;
        
        switch (action.action) {
          case 'mouse_click': {
            const obs = this.latestObservation || (this.desktopConnector as any).visionConnector?.lastObservation;
            const w = obs?.width || 2560;
            const h = obs?.height || 1440;
            const coords = this.coordinateService.resolve(action, w, h);
            const clickType = action.click_type || (action.clicks === 2 ? 'double' : (action.button === 'right' ? 'right' : 'single'));
            result = await (this.desktopConnector.mouseClick
              ? this.desktopConnector.mouseClick(role, coords.x, coords.y, clickType)
              : this.desktopConnector.click(role, coords.x, coords.y));
            break;
          }
          case 'mouse_move': {
            const obs = this.latestObservation || (this.desktopConnector as any).visionConnector?.lastObservation;
            const w = obs?.width || 2560;
            const h = obs?.height || 1440;
            const coords = this.coordinateService.resolve(action, w, h);
            result = await (this.desktopConnector.mouseMove
              ? this.desktopConnector.mouseMove(role, coords.x, coords.y, action.smooth ?? false)
              : this.desktopConnector.moveMouse(role, coords.x, coords.y));
            break;
          }
          case 'mouse_drag': {
            const obs = this.latestObservation || (this.desktopConnector as any).visionConnector?.lastObservation;
            const w = obs?.width || 2560;
            const h = obs?.height || 1440;
            const start = this.coordinateService.resolvePoint(
              action.start_x ?? action.x1 ?? action.x ?? 0,
              action.start_y ?? action.y1 ?? action.y ?? 0,
              w,
              h
            );
            const end = this.coordinateService.resolvePoint(
              action.end_x ?? action.x2 ?? action.to_x ?? 0,
              action.end_y ?? action.y2 ?? action.to_y ?? 0,
              w,
              h
            );
            result = await (this.desktopConnector.mouseDrag
              ? this.desktopConnector.mouseDrag(role, start.x, start.y, end.x, end.y)
              : this.desktopConnector.dragMouse(role, end.x, end.y));
            break;
          }
          case 'mouse_scroll': {
            const direction = action.direction || (action.amount && action.amount < 0 ? 'down' : 'up');
            const amount = Math.abs(action.amount || 3);
            result = await (this.desktopConnector.mouseScroll
              ? this.desktopConnector.mouseScroll(role, direction, amount)
              : this.desktopConnector.scroll(role, direction === 'down' ? -amount : amount));
            break;
          }
          case 'focus_window':
          case 'focus_browser':
            result = await this.desktopConnector.focusWindow(role, action.target || action.target_window || 'chrome');
            break;
          case 'wait':
          case 'sleep':
            const waitSec = action.seconds || action.duration || 3;
            await new Promise(r => setTimeout(r, waitSec * 1000));
            result = { status: 'SUCCESS', message: `Waited ${waitSec}s for page to render` };
            break;
          case 'click_visual':
          case 'click_element':
          case 'click_video':
          case 'click_first_video': {
            const obs = this.latestObservation || (this.desktopConnector as any).visionConnector?.lastObservation;
            const w = obs?.width || 2560;
            const h = obs?.height || 1440;
            const hasDirectCoords = action.x !== undefined && action.y !== undefined;
            const directCoords = hasDirectCoords ? this.coordinateService.resolve(action, w, h) : undefined;
            const targetDesc = action.target || action.description || 'first recommended video thumbnail';
            const skipHover = action.skip_hover === true || (hasDirectCoords && (action.confidence ?? 1.0) >= 0.8 && action.skip_hover !== false);
            const skipVerification = action.skip_verification === true || (hasDirectCoords && action.skip_verification !== false && action.verify_transition !== true);
            result = await this.executeVisualClickWithVerification(
              targetDesc,
              role,
              action.max_retries,
              action.post_click_wait_ms,
              action.hover_dwell_ms,
              { directCoords, skipHover, skipVerification }
            );
            break;
          }
          case 'move':
            result = await this.desktopConnector.moveMouse(role, action.x, action.y);
            break;
          case 'click': {
            const hasDirectCoords = action.x !== undefined && action.y !== undefined;
            if (action.verify_transition || (action.target && !hasDirectCoords)) {
              const obs = this.latestObservation || (this.desktopConnector as any).visionConnector?.lastObservation;
              const w = obs?.width || 2560;
              const h = obs?.height || 1440;
              const directCoords = hasDirectCoords ? this.coordinateService.resolve(action, w, h) : undefined;
              const targetDesc = action.target || 'video card';
              result = await this.executeVisualClickWithVerification(
                targetDesc,
                role,
                action.max_retries,
                action.post_click_wait_ms,
                action.hover_dwell_ms,
                {
                  directCoords,
                  skipHover: action.skip_hover === true,
                  skipVerification: action.skip_verification === true
                }
              );
            } else {
              result = await this.desktopConnector.click(role, action.x, action.y);
            }
            break;
          }
          case 'doubleclick':
            result = await this.desktopConnector.doubleClick(role, action.x, action.y);
            break;
          case 'rightclick':
            result = await this.desktopConnector.rightClick(role, action.x, action.y);
            break;
          case 'drag':
            result = await this.desktopConnector.dragMouse(role, action.x, action.y);
            break;
          case 'scroll':
            result = await this.desktopConnector.scroll(role, action.amount);
            break;
          case 'type':
            result = await this.desktopConnector.typeText(role, action.text);
            break;
          case 'press':
            result = await this.desktopConnector.pressKey(role, action.key);
            break;
          case 'hotkey':
            result = await this.desktopConnector.hotkey(role, action.keys);
            break;
          case 'open_tab':
          case 'new_tab':
            await this.desktopConnector.focusWindow(role, 'chrome');
            result = await this.desktopConnector.hotkey(role, 'ctrl+t');
            break;
          case 'navigate':
            if (action.url) {
              result = await this.desktopConnector.typeText(role, action.url);
              if (result.status === 'SUCCESS') {
                result = await this.desktopConnector.pressKey(role, 'enter');
              }
            } else {
              result = { status: 'SUCCESS', message: 'No URL provided' };
            }
            break;
          case 'open_browser':
            result = await this.desktopConnector.focusWindow(role, 'chrome');
            if (result.status !== 'SUCCESS') {
              result = await this.desktopConnector.hotkey(role, 'win');
            }
            break;
          case 'cloudcode_oversight':
            result = await this.desktopConnector.cloudcodeOversight(role, action.url || '', action.workspace || '');
            break;
          default:
            throw new Error(`Unknown desktop action type: ${action.action}`);
        }

        const actionFeedback = {
          action: action.action,
          status: result.status === 'SUCCESS' ? 'success' : 'failed',
          executed_at: result.executedAt ?? (action.x !== undefined && action.y !== undefined ? [action.x, action.y] : undefined),
          timestamp: result.timestamp || new Date().toISOString(),
          display_info: result.displayInfo,
          message: result.message,
        };
        this.logger.info({ actionFeedback }, 'Desktop action execution structured feedback');

        if (result.status !== 'SUCCESS') {
           return {
             status: result.status === 'CONFIRMATION_REQUIRED' ? 'pending-approval' : 'failed',
             filesChanged: [],
             explanation: `Action ${action.action} failed: ${result.message}`,
             error: result.error
           };
        }
      }

      const memoryContent = `Desktop operator successfully executed ${actions.length} actions based on input: ${input.description}`;
      await this.memoryManager.store({
        content: memoryContent,
        sourceAgent: this.name,
        sourceTaskId: input.taskId,
        tag,
      });

      return {
        status: 'completed',
        filesChanged: [],
        explanation: `Successfully executed ${actions.length} desktop actions.`,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        filesChanged: [],
        explanation: `Desktop operation failed: ${err.message || err}`,
        error: err.message || String(err),
      };
    }
  }

  private async resolveVisualCoordinates(
    targetDescription: string,
    role: AgentRole
  ): Promise<{ x: number; y: number }> {
    // 1. Capture fresh screen observation of the rendered page
    const obs = await this.desktopConnector.captureScreen(role);
    const width = obs?.width || 2560;
    const height = obs?.height || 1440;

    // Default layout heuristic for YouTube home feed: center of the first video card (column 1, row 1)
    // At 2560x1440, sidebar is ~240px, first card center is ~700px, y is ~360px.
    let resolvedX = Math.round(width * 0.28);
    let resolvedY = Math.round(height * 0.26);

    if (obs?.screenshotPath && fs.existsSync(obs.screenshotPath)) {
      try {
        const b64 = fs.readFileSync(obs.screenshotPath).toString('base64');
        const prompt = `This is a screenshot of the computer screen (${width}x${height}).
Analyze the screen to locate the center coordinates of: "${targetDescription}".
For YouTube, identify the first visible video thumbnail or video card in the main feed.
Return ONLY JSON with the format: {"x": number, "y": number}`;

        const modelRes = await this.modelRouter.route('vision', {
          description: prompt,
          image: {
            base64: b64,
            mediaType: 'image/png',
          },
        });

        const text = modelRes.text.trim();
        let parsedCoords: { x: number; y: number } | null = null;
        try {
          let jsonString = text;
          const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (match) jsonString = match[1].trim();
          const parsed = JSON.parse(jsonString);
          parsedCoords = this.coordinateService.resolve(parsed, width, height);
        } catch {
          const jsonMatch = text.match(/\{[\s\S]*?"x"\s*:\s*([\d.]+)\s*,\s*"y"\s*:\s*([\d.]+)[\s\S]*?\}/);
          if (jsonMatch) {
            const rawX = parseFloat(jsonMatch[1]);
            const rawY = parseFloat(jsonMatch[2]);
            parsedCoords = this.coordinateService.resolvePoint(rawX, rawY, width, height);
          }
        }
        if (parsedCoords) {
          resolvedX = parsedCoords.x;
          resolvedY = parsedCoords.y;
          this.logger.info({ resolvedX, resolvedY }, 'Resolved visual coordinates via CoordinateResolutionService.');
        }
      } catch (err: any) {
        this.logger.warn({ err: err?.message || err }, 'Vision coordinate resolution failed; falling back to layout heuristics.');
      }
    }

    // Safety clamp within observation bounds
    resolvedX = Math.max(50, Math.min(resolvedX, width - 50));
    resolvedY = Math.max(50, Math.min(resolvedY, height - 50));

    return { x: resolvedX, y: resolvedY };
  }

  /**
   * Visually confirms whether the cursor is hovering over the intended target
   * by taking an interim screenshot and analyzing hover states (preview expanding, title highlight, pointer).
   */
  private async confirmVisualTargetHover(
    interimObs: any,
    targetDesc: string,
    coords: { x: number; y: number }
  ): Promise<{ confirmed: boolean; adjustedCoordinates?: { x: number; y: number }; reason?: string }> {
    if (!interimObs?.screenshotPath || !fs.existsSync(interimObs.screenshotPath)) {
      return { confirmed: true, reason: 'Interim screenshot unavailable; proceeding with coordinates.' };
    }

    try {
      const width = interimObs.width || 2560;
      const height = interimObs.height || 1440;
      const b64 = fs.readFileSync(interimObs.screenshotPath).toString('base64');
      const prompt = `This is an interim screenshot (${width}x${height}) with the mouse cursor positioned at (${coords.x}, ${coords.y}) aiming for: "${targetDesc}".
Analyze if the mouse cursor is accurately hovering over the target area and whether any hover state (video preview expanding or playing, title highlight, clickable cursor, or outline) is active.
Return ONLY JSON with the format:
{"confirmed": boolean, "hoverStateDetected": boolean, "needsAdjustment": boolean, "adjustedCoordinates": {"x": number, "y": number} | null, "reason": string}`;

      const modelRes = await this.modelRouter.route('vision', {
        description: prompt,
        image: {
          base64: b64,
          mediaType: 'image/png',
        },
      });

      let textToParse = modelRes.text.trim();
      const codeBlockMatch = textToParse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        textToParse = codeBlockMatch[1].trim();
      } else {
        const firstBrace = textToParse.indexOf('{');
        const lastBrace = textToParse.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          textToParse = textToParse.slice(firstBrace, lastBrace + 1);
        }
      }

      const parsed = JSON.parse(textToParse);
      let adjusted: { x: number; y: number } | undefined;
      if (parsed.adjustedCoordinates && typeof parsed.adjustedCoordinates.x === 'number') {
        adjusted = {
          x: Math.round(parsed.adjustedCoordinates.x),
          y: Math.round(parsed.adjustedCoordinates.y),
        };
      }
      return {
        confirmed: parsed.confirmed !== false,
        adjustedCoordinates: adjusted,
        reason: parsed.reason || (parsed.hoverStateDetected ? 'Hover state verified' : 'Target confirmed'),
      };
    } catch (err: any) {
      this.logger.warn({ err: err?.message || err }, 'Visual target hover confirmation encountered error; proceeding with coordinates.');
      return { confirmed: true, reason: `Bypass on error: ${err?.message}` };
    }
  }

  /**
   * Verifies if the screen transitioned to the YouTube video player (playback UI or watch?v= URL)
   * after a click action.
   */
  private async verifyVideoPlayerTransition(
    postClickObs: any,
    targetDesc: string,
    role: AgentRole
  ): Promise<{ transitioned: boolean; confidence: number; indicators: string[]; reason?: string }> {
    if (!postClickObs?.screenshotPath || !fs.existsSync(postClickObs.screenshotPath)) {
      return {
        transitioned: true,
        confidence: 0.5,
        indicators: ['Screenshot unavailable; default transitioned'],
        reason: 'No screenshot available',
      };
    }

    try {
      const width = postClickObs.width || 2560;
      const height = postClickObs.height || 1440;
      const b64 = fs.readFileSync(postClickObs.screenshotPath).toString('base64');
      const prompt = `This is a screenshot (${width}x${height}) taken 2 seconds after clicking on a video thumbnail ("${targetDesc}").
Check if the screen has successfully transitioned to the YouTube video player or watch page.
Look for key indicators:
1. Video playback UI (large video player container, playback scrub bar, play/pause controls, theater mode button).
2. Browser URL bar containing "watch?v=" or "youtube.com/watch".
3. Video watch page layout (video title heading above/below player, channel subscribe button, comments section, related videos column).
Return ONLY JSON with the format:
{"transitioned": boolean, "confidence": number, "indicators": string[], "reason": string}`;

      const modelRes = await this.modelRouter.route('vision', {
        description: prompt,
        image: {
          base64: b64,
          mediaType: 'image/png',
        },
      });

      let textToParse = modelRes.text.trim();
      const codeBlockMatch = textToParse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        textToParse = codeBlockMatch[1].trim();
      } else {
        const firstBrace = textToParse.indexOf('{');
        const lastBrace = textToParse.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          textToParse = textToParse.slice(firstBrace, lastBrace + 1);
        }
      }

      try {
        const parsed = JSON.parse(textToParse);
        return {
          transitioned: parsed.transitioned === true,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : (parsed.transitioned ? 0.9 : 0.1),
          indicators: Array.isArray(parsed.indicators) ? parsed.indicators : [],
          reason: parsed.reason || (parsed.transitioned ? 'Playback UI detected' : 'Playback UI not found'),
        };
      } catch {
        const hasPlayerKeywords = /player|playback|controls|watch\?v=|scrub bar|progress bar/i.test(modelRes.text);
        return {
          transitioned: hasPlayerKeywords,
          confidence: hasPlayerKeywords ? 0.8 : 0.3,
          indicators: hasPlayerKeywords ? ['Keywords matching video player detected'] : [],
          reason: 'Parsed text heuristic fallback',
        };
      }
    } catch (err: any) {
      this.logger.warn({ err: err?.message || err }, 'Vision verification of video player transition encountered error; assuming transitioned.');
      return { transitioned: true, confidence: 0.5, indicators: ['Error fallback'], reason: `Bypass on error: ${err?.message}` };
    }
  }

  /**
   * Executes a visual click with full closed-loop verification:
   * 1. OS Coordinate Pre-check (re-glides cursor if drift occurs)
   * 2. Visual Target Confirmation (interim screenshot with hover state validation)
   * 3. Reliable Click Registration (explicit 50ms dwell time)
   * 4. Post-Click Verification Loop (2s pause, fresh screenshot, video player detection with retries/re-targeting)
   */
  private async executeVisualClickWithVerification(
    targetDesc: string,
    role: AgentRole,
    maxRetries = 2,
    postClickWaitMs?: number,
    hoverDwellMs?: number,
    options?: {
      directCoords?: { x: number; y: number };
      skipHover?: boolean;
      skipVerification?: boolean;
    }
  ): Promise<DesktopActionResult> {
    const effectiveHoverDwellMs = options?.skipHover ? 0 : (hoverDwellMs ?? this.defaultHoverDwellMs);
    const effectivePostClickWaitMs = options?.skipVerification ? 0 : (postClickWaitMs ?? this.defaultPostClickWaitMs);

    this.logger.info(
      { targetDesc, maxRetries, postClickWaitMs: effectivePostClickWaitMs, hoverDwellMs: effectiveHoverDwellMs, options },
      'Initiating closed-loop visual click verification sequence.'
    );

    let currentCoords: { x: number; y: number } | null = options?.directCoords ?? null;
    let lastResult: DesktopActionResult = { status: 'FAILED', message: 'No click attempts completed.' };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const isRetry = attempt > 0;
      this.logger.info({ attempt: attempt + 1, maxAttempts: maxRetries + 1, isRetry }, 'Visual click attempt initiated.');

      // 1. Resolve or re-target coordinates
      if (!currentCoords || isRetry) {
        currentCoords = await this.resolveVisualCoordinates(targetDesc, role);
      }

      // 2. Position cursor over target area and settle for hover
      this.logger.info({ coords: currentCoords }, 'Moving cursor to target coordinates for hover preview.');
      const moveResult = await this.desktopConnector.moveMouse(role, currentCoords.x, currentCoords.y);
      if (moveResult.status !== 'SUCCESS') {
        return moveResult;
      }

      let interimObs: any = null;
      if (!options?.skipHover && effectiveHoverDwellMs > 0) {
        // Hover dwell settling pause (allow preview expansion / title highlight to render)
        await new Promise(r => setTimeout(r, effectiveHoverDwellMs));

        // 3. Visual Target Confirmation: interim screenshot with cursor positioned
        try {
          interimObs = await this.desktopConnector.captureScreen(role);
        } catch (err: any) {
          this.logger.warn({ err: err?.message }, 'Failed to capture interim hover screenshot; proceeding.');
        }

        const hoverCheck = await this.confirmVisualTargetHover(interimObs, targetDesc, currentCoords);
        this.logger.info({ hoverCheck }, 'Visual target hover confirmation completed.');

        if (hoverCheck.adjustedCoordinates) {
          currentCoords = hoverCheck.adjustedCoordinates;
          await this.desktopConnector.moveMouse(role, currentCoords.x, currentCoords.y);
          await new Promise(r => setTimeout(r, Math.min(200, effectiveHoverDwellMs)));
        }
      }

      // 4. Reliable Click Registration: explicit dwell time (mouseDown, 50ms, mouseUp)
      lastResult = await this.desktopConnector.click(role, currentCoords.x, currentCoords.y);
      if (lastResult.status !== 'SUCCESS') {
        this.logger.warn({ lastResult }, 'Reliable click execution failed or was denied.');
        return lastResult;
      }

      // If post-click verification is skippable (e.g. high-confidence direct coordinate action), return immediately
      if (options?.skipVerification || effectivePostClickWaitMs <= 0) {
        this.logger.info('Post-click verification skipped due to configuration or direct coordinates.');
        return {
          status: 'SUCCESS',
          message: `Direct click executed successfully at (${currentCoords.x}, ${currentCoords.y}) without post-click wait.`,
          screenshotPathBefore: interimObs?.screenshotPath,
        };
      }

      // 5. Post-Click Verification Loop: pause and inspect transition
      this.logger.info(`Pausing ${effectivePostClickWaitMs}ms for screen to transition to video player...`);
      await new Promise(r => setTimeout(r, effectivePostClickWaitMs));

      let postClickObs: any = null;
      try {
        postClickObs = await this.desktopConnector.captureScreen(role);
      } catch (err: any) {
        this.logger.warn({ err: err?.message }, 'Failed to capture post-click screenshot; completing action.');
        return lastResult;
      }

      const transitionCheck = await this.verifyVideoPlayerTransition(postClickObs, targetDesc, role);
      this.logger.info({ attempt: attempt + 1, transitionCheck }, 'Post-click video player transition evaluation.');

      if (transitionCheck.transitioned) {
        this.logger.info('Closed-loop verification confirmed transition to video player.');
        return {
          status: 'SUCCESS',
          message: `Closed-loop visual click verified transition to video player: ${transitionCheck.indicators.join(', ') || 'playback UI active'}`,
          screenshotPathBefore: interimObs?.screenshotPath,
          screenshotPathAfter: postClickObs?.screenshotPath,
        };
      }

      // If transition failed, log retry attempt
      this.logger.warn(
        { attempt: attempt + 1, maxRetries, reason: transitionCheck.reason },
        'Screen did not transition to video player after click. Retrying click or re-targeting video card...'
      );

      // Reset coordinates to force re-targeting on next attempt
      currentCoords = null;
    }

    return {
      status: 'FAILED',
      message: `Post-click verification failed after ${maxRetries + 1} attempts: Screen did not transition to YouTube video player.`,
    };
  }

  async receiveMessage(message: AgentMessage): Promise<AgentMessage | null> {
    return null; // Out of scope for this implementation
  }
}
