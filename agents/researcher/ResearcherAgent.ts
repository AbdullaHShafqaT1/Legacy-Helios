import { Logger } from 'pino';
import { Agent, AgentTaskInput, AgentResult } from '../shared/Agent.js';
import { ModelRouter } from '../../core/src/router/modelRouter.js';
import { FilesystemConnector } from '../../connectors/filesystem/FilesystemConnector.js';
import { redactSecrets } from '../../core/src/lib/redact.js';

export interface ResearchAgentResult extends AgentResult {
  summary?: string;
  citations?: string[];
  confidence?: string;
  caveats?: string[];
}

export class ResearcherAgent implements Agent {
  readonly name = 'researcher';
  private readonly modelRouter: ModelRouter;
  private readonly filesystemConnector?: FilesystemConnector;
  private readonly logger: Logger;

  constructor(
    modelRouter: ModelRouter,
    filesystemConnector: FilesystemConnector | undefined,
    logger: Logger
  ) {
    this.modelRouter = modelRouter;
    this.filesystemConnector = filesystemConnector;
    this.logger = logger;
  }

  /**
   * Process a research task. Evaluates natural-language query and optional scope/constraints,
   * inspects local file context via read-only FilesystemConnector calls if requested,
   * and routes to the Model Router under the 'research' task type.
   *
   * @param input Research query description and optional file/scope context.
   * @returns Resolves to a ResearchAgentResult with structured summary, citations, and confidence.
   */
  async process(input: AgentTaskInput): Promise<ResearchAgentResult> {
    const fileContext = input.fileContext as Record<string, any> | undefined;
    const pathsToRead: string[] = [];

    if (fileContext && typeof fileContext === 'object') {
      if (typeof fileContext.targetPath === 'string') {
        pathsToRead.push(fileContext.targetPath);
      } else if (Array.isArray(fileContext.targetPath)) {
        for (const p of fileContext.targetPath) {
          if (typeof p === 'string' && !pathsToRead.includes(p)) {
            pathsToRead.push(p);
          }
        }
      }

      if (Array.isArray(fileContext.paths)) {
        for (const p of fileContext.paths) {
          if (typeof p === 'string' && !pathsToRead.includes(p)) {
            pathsToRead.push(p);
          }
        }
      }

      if (Array.isArray(fileContext.readPaths)) {
        for (const p of fileContext.readPaths) {
          if (typeof p === 'string' && !pathsToRead.includes(p)) {
            pathsToRead.push(p);
          }
        }
      }
    }

    const sourcesRead: string[] = [];
    const fileContents: Record<string, string> = {};
    const readErrors: string[] = [];

    if (this.filesystemConnector && pathsToRead.length > 0) {
      for (const p of pathsToRead) {
        try {
          const content = await this.filesystemConnector.readFile(this.name, p);
          sourcesRead.push(p);
          fileContents[p] = content;
        } catch (err: any) {
          const errMsg = redactSecrets(err?.message || String(err)) as string;
          if (errMsg.includes('is a directory')) {
            try {
              const items = await this.filesystemConnector.listDir(this.name, p);
              sourcesRead.push(p);
              fileContents[p] =
                `[Directory listing for ${p}]: ` +
                items.map((i) => `${i.isDirectory ? '[DIR]' : '[FILE]'} ${i.name}`).join(', ');
              continue;
            } catch (dirErr: any) {
              const dirErrMsg = redactSecrets(dirErr?.message || String(dirErr)) as string;
              readErrors.push(`Failed to list directory "${p}": ${dirErrMsg}`);
              continue;
            }
          }
          readErrors.push(`Failed to read "${p}": ${errMsg}`);
        }
      }
    }

    const enrichedDescription =
      Object.keys(fileContents).length > 0
        ? `${input.description}\n\nContext from files:\n` +
          Object.entries(fileContents)
            .map(([fp, c]) => `--- ${fp} ---\n${c}`)
            .join('\n\n')
        : input.description;

    // 1. Route task to model router ('research'). Exceptions bypass catch and propagate out.
    const modelResponse = await this.modelRouter.route('research', {
      description: enrichedDescription,
      fileContext: input.fileContext,
    });

    // 2. Format structured research result
    let summary = modelResponse.text;
    let confidence = 'high';
    const caveats: string[] = [...readErrors];
    const citations: string[] = [...sourcesRead];

    try {
      const parsed = JSON.parse(modelResponse.text);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.summary === 'string') summary = parsed.summary;
        if (typeof parsed.confidence === 'string') confidence = parsed.confidence;
        if (Array.isArray(parsed.caveats)) {
          for (const cv of parsed.caveats) {
            if (typeof cv === 'string' && !caveats.includes(cv)) {
              caveats.push(cv);
            }
          }
        }
        if (Array.isArray(parsed.citations)) {
          for (const c of parsed.citations) {
            if (typeof c === 'string' && !citations.includes(c)) {
              citations.push(c);
            }
          }
        }
      }
    } catch {
      // If response text is not JSON, use raw text as summary/explanation
    }

    return {
      status: 'completed',
      filesChanged: [], // ResearcherAgent is read-only; never mutates files
      explanation: summary,
      summary,
      citations,
      confidence,
      caveats,
    };
  }
}
