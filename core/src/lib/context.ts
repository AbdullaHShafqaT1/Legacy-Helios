import { AsyncLocalStorage } from 'node:async_hooks';

export interface ExecutionContext {
  taskId: string;
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>();
