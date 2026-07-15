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

export interface Agent {
  readonly name: string;
  process(input: AgentTaskInput): Promise<AgentResult>;
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
