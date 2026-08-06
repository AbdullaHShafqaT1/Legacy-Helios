import { TaskRow } from '../../core/src/queue/index.js';

export interface AgentTaskInput {
  taskId: string;
  description: string;
  fileContext?: unknown;
}

export interface AgentResult {
  status: 'completed' | 'failed';
  filesChanged: string[];
  explanation: string;
  error?: string;
}

export interface AgentMessage {
  id: string;
  sender: string;
  recipient: string;
  type: string;
  payload: any;
  correlationId?: string;
  actingOnBehalfOf?: string;
  timestamp: string;
  hops?: string[];
}

export interface Agent {
  readonly name: string;
  process(input: AgentTaskInput): Promise<AgentResult>;
  receiveMessage?(message: AgentMessage): Promise<AgentMessage | null>;
}

/**
 * Maps a TaskRow database record to an AgentTaskInput object.
 * Parses the raw file_context string back into an object if it exists.
 *
 * @param task The raw database TaskRow record.
 * @returns An AgentTaskInput payload.
 */
export function toAgentInput(task: TaskRow): AgentTaskInput {
  return {
    taskId: task.id,
    description: task.description,
    fileContext: task.file_context ? JSON.parse(task.file_context) : undefined,
  };
}

/**
 * Derives a project/context tag from the task input.
 * First checks fileContext properties, then parses description for tags/brackets, and defaults to 'general'.
 */
export function deriveProjectTag(input: AgentTaskInput): string {
  const fileContext = input.fileContext as Record<string, any> | undefined;
  if (fileContext && typeof fileContext === 'object') {
    if (typeof fileContext.tag === 'string' && fileContext.tag.trim().length > 0) {
      return fileContext.tag.trim();
    }
    if (typeof fileContext.project === 'string' && fileContext.project.trim().length > 0) {
      return fileContext.project.trim();
    }
  }

  // Check brackets prefix like [project: foo] or [project-foo]
  const matchBrackets = input.description.match(/\[project:\s*([a-zA-Z0-9_-]+)\]/i);
  if (matchBrackets && matchBrackets[1]) {
    return matchBrackets[1].trim();
  }

  const matchHash = input.description.match(/#([a-zA-Z0-9_-]+)/);
  if (matchHash && matchHash[1]) {
    return matchHash[1].trim();
  }

  return 'general';
}
