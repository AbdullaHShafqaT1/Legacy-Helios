#!/usr/bin/env node

import fs from 'node:fs';
import { ConfigError } from '../core/src/lib/config.js';
import { openCliContext, CliContext } from '../core/src/bootstrap.js';
import { defaultStopSignalPath } from '../core/src/orchestrator.js';

function printHelp(): void {
  console.log(`
Jarvis OS - Command Line Interface (CLI)

Usage:
  jarvis <command> [arguments] [flags]

Commands:
  submit "<description>" [--priority <n>] [--depends-on <taskId>] [--target-path <path>] [--max-retries <n>] [--id <id>]
    Enqueues a new task to be processed.
    Flags:
      --priority <n>          Priority of the task (integer, default: 0)
      --depends-on <taskId>   Optional dependency ID that must complete first
      --target-path <path>    Optional path to write the model output to
      --max-retries <n>       Maximum attempts allowed (default: 3)
      --id <id>               Optional custom task ID for idempotent resubmission

  status
    Displays a summary of the task queue state and details of all tasks.

  logs [--limit <n>]
    Displays recent audit log logs.
    Flags:
      --limit <n>             Maximum rows to display (default: 20)

  stop
    Triggers an emergency halt. Running orchestrator will stop claiming tasks.

  approve <taskId>
    Approves pending Unattended Approval requests for the specified task ID.

  briefing [--read-aloud]
    Generates an LLM summary of yesterday's completed tasks.
    Flags:
      --read-aloud            Reads the briefing aloud using TTS.

  listen
    Starts the local voice assistant in continuously listening mode.

  help
    Prints this help message.
`);
}

function parseArgs(args: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

async function run(): Promise<void> {
  const cmdRaw = process.argv[2];
  const command = cmdRaw?.toLowerCase();
  const rawArgs = process.argv.slice(3);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  const validCommands = ['submit', 'status', 'logs', 'stop', 'approve', 'briefing', 'listen'];
  if (!validCommands.includes(command)) {
    process.stderr.write(`Error: Unrecognized command "${cmdRaw}"\n`);
    printHelp();
    process.exit(1);
  }

  let ctx: CliContext | null = null;

  try {
    ctx = openCliContext('jarvis-cli');
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`FATAL: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`FATAL: Unexpected configuration load error: ${error}\n`);
    process.exit(1);
  }

  try {
    const { flags, positional } = parseArgs(rawArgs);

    if (command === 'submit') {
      const description = positional[0]?.trim();
      if (!description) {
        printHelp();
        throw new Error('Task description is required for submit command.');
      }

      let priority: number | undefined;
      if (flags['priority']) {
        priority = parseInt(flags['priority'], 10);
        if (isNaN(priority)) {
          throw new Error('Flag --priority must be an integer.');
        }
      }

      const dependsOn = flags['depends-on'];
      const targetPath = flags['target-path'];
      const fileContext = targetPath ? { targetPath } : undefined;

      let maxRetries: number | undefined;
      if (flags['max-retries']) {
        maxRetries = parseInt(flags['max-retries'], 10);
        if (isNaN(maxRetries)) {
          throw new Error('Flag --max-retries must be an integer.');
        }
      }

      const id = flags['id'];

      const task = ctx.queue.enqueue({
        id,
        description,
        fileContext,
        priority,
        dependsOn,
        maxRetries,
        source: 'cli',
      });

      console.log(`Task submitted successfully. ID: ${task.id} [Status: ${task.status}]`);
    } else if (command === 'status') {
      const tasks = ctx.queue.listAll();

      if (tasks.length === 0) {
        console.log('No tasks submitted yet.');
        return;
      }

      const counts = {
        pending: 0,
        'in-progress': 0,
        completed: 0,
        failed: 0,
        blocked: 0,
      };

      for (const t of tasks) {
        if (t.status in counts) {
          counts[t.status]++;
        }
      }

      console.log(`pending=${counts.pending}  in-progress=${counts['in-progress']}  completed=${counts.completed}  failed=${counts.failed}  blocked=${counts.blocked}\n`);

      for (const t of tasks) {
        const shortId = t.id.slice(0, 8);
        const depStr = t.depends_on ? ` depends_on=${t.depends_on.slice(0, 8)}` : '';
        const errStr = t.error ? ` (Error: ${t.error})` : '';
        
        console.log(`[${t.status.toUpperCase()}] id=${shortId} priority=${t.priority} retries=${t.retries}/${t.max_retries}${depStr} - ${t.description}${errStr}`);
      }
    } else if (command === 'logs') {
      let limit = 20;
      if (flags['limit']) {
        limit = parseInt(flags['limit'], 10);
        if (isNaN(limit) || limit <= 0) {
          throw new Error('Flag --limit must be a positive integer.');
        }
      }

      const logs = ctx.auditLog.recent(limit);
      if (logs.length === 0) {
        console.log('No audit logs found.');
        return;
      }

      for (const row of logs) {
        const ts = row.timestamp;
        if (row.event_type === 'decision') {
          console.log(`[DECISION] [${ts}] actor=${row.actor} action=${row.action} status=${row.approval_status} approver=${row.approver ?? 'n-a'} params=${row.params_json || '{}'}`);
        } else {
          console.log(`[OUTCOME] [${ts}] actor=${row.actor} action=${row.action} outcome=${row.outcome ?? ''}`);
        }
      }
    } else if (command === 'stop') {
      const stopSignalPath = defaultStopSignalPath(ctx.config.dbPath);

      fs.writeFileSync(stopSignalPath, new Date().toISOString(), 'utf8');

      const correlationId = 'stop-' + Date.now();
      ctx.auditLog.recordDecision({
        correlationId,
        actor: 'cli',
        action: 'emergency-stop',
        params: { stopSignalPath },
        approvalStatus: 'n-a',
        approver: 'user',
      });

      ctx.auditLog.recordOutcome(
        correlationId,
        'cli',
        'emergency-stop',
        'stop signal written; orchestrator will halt within one poll cycle'
      );

      console.log(`Emergency stop signal written to: ${stopSignalPath}`);
      console.log('The running orchestrator daemon will stop claiming new tasks within one poll cycle.');
      console.log('To resume processing, please delete the signal file at the path above.');
    } else if (command === 'approve') {
      const taskId = positional[0]?.trim();
      if (!taskId) {
        throw new Error('Task ID is required for approve command.');
      }
      const now = new Date().toISOString();
      const stmt = ctx.db.prepare(`
        UPDATE pending_approvals 
        SET status = 'granted', updated_at = ?
        WHERE task_id = ? AND status = 'pending'
      `);
      const result = stmt.run(now, taskId);
      if (result.changes > 0) {
        console.log(`Approved pending requests for task: ${taskId}`);
      } else {
        console.log(`No pending approvals found for task: ${taskId}`);
      }
    } else if (command === 'briefing') {
      const { ClaudeConnector } = await import('../connectors/claude-api/ClaudeConnector.js');
      const claude = new ClaudeConnector({
        apiKey: ctx.config.anthropicApiKey!,
        model: ctx.config.model,
        logger: ctx.logger,
      });

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString();

      const tasks = ctx.db.prepare(`
        SELECT id, description, result_json FROM tasks
        WHERE status = 'completed' AND updated_at >= ?
      `).all(yesterdayStr) as any[];

      if (tasks.length === 0) {
        console.log('No tasks completed in the last 24 hours.');
        return;
      }

      console.log(`Found ${tasks.length} completed tasks. Generating briefing...`);
      const prompt = `Summarize the following completed tasks from the last 24 hours into a concise briefing. Highlight key achievements.\n\n` + 
                     tasks.map(t => `- Task ${t.id}: ${t.description}\n  Result: ${t.result_json?.substring(0, 500)}`).join('\n');
                     
      const res = await claude.invoke({
        taskId: 'briefing',
        description: prompt,
      } as any);
      
      console.log('\n--- DAILY BRIEFING ---\n');
      console.log(res.text);
      console.log('\n----------------------\n');

      if (flags['read-aloud']) {
        const { VoiceManager } = await import('../core/src/voice/VoiceManager.js');
        const { LocalAudioEngine } = await import('../core/src/voice/engines/LocalAudioEngine.js');
        const engine = new LocalAudioEngine(ctx.logger);
        const voiceManager = new VoiceManager(engine, ctx.logger, {
          sttConfidenceThreshold: 0.8,
          wakeWordSensitivity: 0.5,
        });
        await voiceManager.init();
        console.log('Reading briefing aloud...');
        await voiceManager.speak(res.text);
      }
    } else if (command === 'listen') {
      const { VoiceManager } = await import('../core/src/voice/VoiceManager.js');
      // For demonstration in CLI without real hardware by default, we can use LocalAudioEngine
      // but it will fail fast if Python isn't available. In a real environment, it would run.
      // If we are in test mode, we'd use MockAudioEngine. We'll try Local.
      let engine: any;
      try {
        const { LocalAudioEngine } = await import('../core/src/voice/engines/LocalAudioEngine.js');
        engine = new LocalAudioEngine(ctx.logger);
        await engine.init();
      } catch (e: any) {
        ctx.logger.warn({ err: e }, 'LocalAudioEngine unavailable, falling back to MockAudioEngine for demonstration.');
        const { MockAudioEngine } = await import('../core/src/voice/engines/MockAudioEngine.js');
        engine = new MockAudioEngine();
        await engine.init();
      }

      const voiceManager = new VoiceManager(engine, ctx.logger, {
        sttConfidenceThreshold: 0.8,
        wakeWordSensitivity: 0.5,
      });

      // EXACT SAME submission path as 'submit'
      voiceManager.on('command', (text: string) => {
        try {
          const task = ctx!.queue.enqueue({
            description: text,
            source: 'voice',
          });
          console.log(`[Voice] Task submitted successfully. ID: ${task.id} [Status: ${task.status}]`);
          voiceManager.speak("Task submitted.").catch(() => {});
        } catch (e: any) {
          console.error(`[Voice] Failed to submit task: ${e.message}`);
          voiceManager.speak("I'm sorry, I couldn't submit that task.").catch(() => {});
        }
      });

      await voiceManager.init();
      console.log('Jarvis is now listening. Say the wake word to interact.');
      
      // Keep process alive
      process.stdin.resume();
    }
  } catch (error: any) {
    process.stderr.write(`Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (ctx && ctx.db) {
      ctx.db.close();
    }
  }
}

run();
