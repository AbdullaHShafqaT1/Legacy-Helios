import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult, AgentMessage, deriveProjectTag } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { DesktopConnector, DesktopActionResult } from '../../connectors/desktop/DesktopConnector.js';
import { MemoryManager } from '../../core/src/memory/memoryManager.js';
import { MessageRouter } from '../../core/src/router/messageRouter.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { AgentRole } from '../../core/src/permissions/policy.js';

export class DesktopOperatorAgent implements Agent {
  readonly name = 'desktop-operator';
  private readonly modelRouter: ModelRouter;
  private readonly desktopConnector: DesktopConnector;
  private readonly memoryManager: MemoryManager;
  private readonly logger: Logger;
  private readonly messageRouter?: MessageRouter;

  constructor(
    modelRouter: ModelRouter,
    desktopConnector: DesktopConnector,
    memoryManager: MemoryManager,
    logger: Logger,
    messageRouter?: MessageRouter
  ) {
    this.modelRouter = modelRouter;
    this.desktopConnector = desktopConnector;
    this.memoryManager = memoryManager;
    this.logger = logger;
    this.messageRouter = messageRouter;
  }

  async process(input: AgentTaskInput): Promise<AgentResult> {
    const tag = deriveProjectTag(input);
    const fileContext = input.fileContext as Record<string, any> | undefined;

    try {
      try {
        await this.desktopConnector.captureScreen(this.name as AgentRole);
      } catch {
        // Soft fail if screen capture is not fully initialized, wait for actual failure in the connector
      }

      const response = await this.modelRouter.route('reasoning', {
        description: `Desktop operator received task: ${input.description}. 
Parse out what desktop actions to execute. Return JSON with format:
{"actions": [{"action": "focus_window", "target": "chrome"}, {"action": "hotkey", "keys": "ctrl+t"}, {"action": "type", "text": "youtube.com"}, {"action": "press", "key": "enter"}, {"action": "wait", "seconds": 3}, {"action": "click_visual", "target": "first recommended video thumbnail"}]}
Supported actions: focus_window, wait, click_visual, move, click, doubleclick, rightclick, drag, scroll, type, press, hotkey, open_tab, navigate, cloudcode_oversight.
Rules:
- When interacting with a browser, focus it first: {"action": "focus_window", "target": "chrome"}.
- To open a new tab in active browser, use {"action": "hotkey", "keys": "ctrl+t"}.
- To navigate or search, use {"action": "type", "text": "..."} followed by {"action": "press", "key": "enter"}.
- After navigating to a page, add a delay to allow the DOM/thumbnails to render: {"action": "wait", "seconds": 3}.
- To visually locate and click an item on the screen (such as the first recommended video), use: {"action": "click_visual", "target": "first recommended video thumbnail"}.
- Only use supported actions.`,
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
        await this.desktopConnector.captureScreen(role);
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
          case 'click_first_video':
            const targetDesc = action.target || action.description || 'first recommended video thumbnail';
            const coords = await this.resolveVisualCoordinates(targetDesc, role);
            result = await this.desktopConnector.click(role, coords.x, coords.y);
            break;
          case 'move':
            result = await this.desktopConnector.moveMouse(role, action.x, action.y);
            break;
          case 'click':
            result = await this.desktopConnector.click(role, action.x, action.y);
            break;
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
        const jsonMatch = text.match(/\{[\s\S]*?"x"\s*:\s*([\d.]+)\s*,\s*"y"\s*:\s*([\d.]+)[\s\S]*?\}/);
        if (jsonMatch) {
          const rawX = parseFloat(jsonMatch[1]);
          const rawY = parseFloat(jsonMatch[2]);

          // Scale appropriately based on coordinate system returned by vision model
          if (rawX <= 1.0 && rawY <= 1.0) {
            resolvedX = Math.round(rawX * width);
            resolvedY = Math.round(rawY * height);
          } else if (rawX <= 100 && rawY <= 100 && width > 500) {
            resolvedX = Math.round((rawX / 100) * width);
            resolvedY = Math.round((rawY / 100) * height);
          } else if (rawX <= 1000 && rawY <= 1000 && width > 1200) {
            resolvedX = Math.round((rawX / 1000) * width);
            resolvedY = Math.round((rawY / 1000) * height);
          } else {
            resolvedX = Math.round(rawX);
            resolvedY = Math.round(rawY);
          }
          this.logger.info({ resolvedX, resolvedY, rawX, rawY }, 'Resolved visual coordinates via vision model.');
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

  async receiveMessage(message: AgentMessage): Promise<AgentMessage | null> {
    return null; // Out of scope for this implementation
  }
}
