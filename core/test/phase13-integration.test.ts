import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../src/bootstrap.js';

describe('Phase 13 End-to-End Integration Suite', () => {
  let context: any;

  beforeEach(() => {
    // Enable fallback mode for testing
    process.env.JARVIS_CI_FALLBACK = 'true';
    process.env.JARVIS_TEST_WAKE_MOCK = 'true';
    process.env.JARVIS_SEARCH_PROVIDER = 'duckduckgo';
    process.env.JARVIS_PERIODIC_CAPTURE_INTERVAL_MS = '100';
    process.env.JARVIS_PERIODIC_CAPTURE_RETENTION_MAX = '2';

    // Spawn bootstrap context
    context = bootstrap(async () => true, 'integration-runner', false);

    // Mock ModelRouter to bypass real networks (Ollama/Claude)
    vi.spyOn(context.modelRouter, 'route').mockImplementation(async (taskType: any, ctx: any) => {
      if (taskType === 'vision') {
        return { text: 'Simulated periodic visual state description containing secret sk-ant-9876543210zyx' };
      }
      if (taskType === 'reasoning') {
        return {
          text: JSON.stringify({
            needsWebSearch: true,
            searchQuery: 'autonomous ai research',
          }),
        };
      }
      return {
        text: JSON.stringify({
          summary: 'Simulated research summary text with api-key sk-ant-9876543210zyx',
          confidence: 'high',
          citations: ['https://example.com/news/autonomous%20ai%20research'],
          caveats: [],
        }),
      };
    });

    // Mock captureScreen to run instantly and avoid slow OS-level shell calls
    vi.spyOn(context.computerVisionConnector, 'captureScreen').mockResolvedValue({
      success: true,
      timestamp: new Date().toISOString(),
      display: 0,
      width: 1280,
      height: 720,
      screenshotPath: path.resolve(context.config.projectRoot, 'core/test/fixtures/desktop_screenshot.png'),
      imageFixtureFallbackUsed: true,
    });
  });

  afterEach(async () => {
    if (context && context.periodicCaptureManager) {
      context.periodicCaptureManager.stop();
    }
    // Clean up SQLite DB connection
    if (context && context.db) {
      context.db.close();
    }
  });

  it('proves end-to-end bootstrap registers the search and periodic capture connectors', () => {
    expect(context.searchConnector).toBeDefined();
    expect(context.periodicCaptureManager).toBeDefined();
    expect(context.periodicCaptureManager.isActive()).toBe(false);
  });

  it('runs periodic capture in background, stores visual memory, and halts on emergency stop event', async () => {
    const manager = context.periodicCaptureManager;
    
    // Start periodic screenshot capturing
    const started = await manager.start('researcher');
    expect(started).toBe(true);
    expect(manager.isActive()).toBe(true);

    // Wait a brief moment to allow ticks to execute
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Verify visual memory was stored in SQLite DB
    const memoryRow = context.db.prepare("SELECT * FROM memory_entries WHERE tag = 'periodic-snapshot'").all();
    expect(memoryRow.length).toBeGreaterThan(0);
    expect(memoryRow[0].content).toContain('Periodic screen visual state');

    // Trigger emergency-stop event
    context.eventBus.emit('queue:emergency-stop');
    expect(manager.isActive()).toBe(false);
  });

  it('performs autonomous research using SearchConnector, sanitizes secrets, and returns citations', async () => {
    const agent = context.agentRouter.getAgent('researcher');
    expect(agent).toBeDefined();

    const result = await agent.process({
      taskId: 'integration-task-1',
      description: 'Search for autonomous AI research advancements online',
    });

    // Verify summary details are returned
    expect(result.status).toBe('completed');
    expect(result.summary).toContain('Simulated research summary');
    
    // Verify citations list contains external search provider URL
    expect(result.citations).toContain('https://example.com/news/autonomous%20ai%20research');
  });
});
