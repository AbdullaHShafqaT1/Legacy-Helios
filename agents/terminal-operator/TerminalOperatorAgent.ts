import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult, AgentMessage, deriveProjectTag } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { TerminalConnector } from '../../connectors/terminal/TerminalConnector.js';
import { MemoryManager } from '../../core/src/memory/memoryManager.js';
import { MessageRouter } from '../../core/src/router/messageRouter.js';
import crypto from 'node:crypto';

export class TerminalOperatorAgent implements Agent {
  readonly name = 'terminal-operator';
  private readonly modelRouter: ModelRouter;
  private readonly terminalConnector: TerminalConnector;
  private readonly memoryManager: MemoryManager;
  private readonly logger: Logger;
  private readonly messageRouter?: MessageRouter;

  constructor(
    modelRouter: ModelRouter,
    terminalConnector: TerminalConnector,
    memoryManager: MemoryManager,
    logger: Logger,
    messageRouter?: MessageRouter
  ) {
    this.modelRouter = modelRouter;
    this.terminalConnector = terminalConnector;
    this.memoryManager = memoryManager;
    this.logger = logger;
    this.messageRouter = messageRouter;
  }

  async process(input: AgentTaskInput): Promise<AgentResult> {
    const tag = deriveProjectTag(input);
    const fileContext = input.fileContext as Record<string, any> | undefined;
    const command = fileContext?.command || '';

    try {
      if (command) {
        const res = await this.terminalConnector.execute(this.name, command, fileContext?.cwd);

        // Store memory
        const memoryContent = `Terminal executed "${command}" (exit code: ${res.exitCode}). Output: ${res.stdout.substring(0, 200)}...`;
        await this.memoryManager.store({
          content: memoryContent,
          sourceAgent: this.name,
          sourceTaskId: input.taskId,
          tag,
        });

        if (res.error) {
          return {
            status: 'failed',
            filesChanged: [],
            explanation: `Command failed: ${res.error}. Stdout: ${res.stdout}. Stderr: ${res.stderr}`,
            error: res.error,
          };
        }

        if (res.exitCode !== 0) {
          return {
            status: 'failed',
            filesChanged: [],
            explanation: `Command exited with non-zero code ${res.exitCode}. Stdout: ${res.stdout}. Stderr: ${res.stderr}`,
            error: `Exit code: ${res.exitCode}`,
          };
        }

        return {
          status: 'completed',
          filesChanged: [],
          explanation: `Command successfully executed. Stdout: ${res.stdout}`,
        };
      }

      // If no explicit command, parse via Model Router
      const response = await this.modelRouter.route('reasoning', {
        description: `Terminal operator received task: ${input.description}. Parse out what command to run. Return JSON with format {"command": "..."}`,
        fileContext: input.fileContext,
      });

      let targetCmd = '';
      try {
        const parsed = JSON.parse(response.text);
        targetCmd = parsed.command;
      } catch {
        targetCmd = response.text.trim();
      }

      if (!targetCmd) {
        return {
          status: 'failed',
          filesChanged: [],
          explanation: 'Could not extract a valid command to run from the task description.',
        };
      }

      const res = await this.terminalConnector.execute(this.name, targetCmd, fileContext?.cwd);

      if (res.error) {
        return {
          status: 'failed',
          filesChanged: [],
          explanation: `Command failed: ${res.error}. Stdout: ${res.stdout}. Stderr: ${res.stderr}`,
          error: res.error,
        };
      }

      if (res.exitCode !== 0) {
        return {
          status: 'failed',
          filesChanged: [],
          explanation: `Command exited with non-zero code ${res.exitCode}. Stdout: ${res.stdout}. Stderr: ${res.stderr}`,
          error: `Exit code: ${res.exitCode}`,
        };
      }

      return {
        status: 'completed',
        filesChanged: [],
        explanation: `Command successfully executed. Stdout: ${res.stdout}`,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        filesChanged: [],
        explanation: `Terminal operation failed: ${err.message || err}`,
        error: err.message || String(err),
      };
    }
  }

  async receiveMessage(message: AgentMessage): Promise<AgentMessage | null> {
    if (message.type === 'terminal-run') {
      const payload = message.payload;
      const actingOnBehalfOf = message.sender as any;

      try {
        const res = await this.terminalConnector.execute(this.name, payload.command, payload.cwd, actingOnBehalfOf);
        return {
          id: crypto.randomUUID(),
          sender: this.name,
          recipient: message.sender,
          type: 'terminal-run-response',
          payload: {
            success: !res.error && res.exitCode === 0,
            stdout: res.stdout,
            stderr: res.stderr,
            exitCode: res.exitCode,
            error: res.error,
          },
          correlationId: message.id,
          timestamp: new Date().toISOString(),
        };
      } catch (err: any) {
        return {
          id: crypto.randomUUID(),
          sender: this.name,
          recipient: message.sender,
          type: 'terminal-run-response',
          payload: { success: false, error: err.message || String(err) },
          correlationId: message.id,
          timestamp: new Date().toISOString(),
        };
      }
    }
    return null;
  }
}
