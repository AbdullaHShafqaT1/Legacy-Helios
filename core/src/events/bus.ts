import { EventEmitter } from 'node:events';

export interface JarvisEvents {
  'task:started': { taskId: string; agent: string };
  'task:completed': { taskId: string };
  'task:failed': { taskId: string; error: string; willRetry: boolean };
  'queue:emergency-stop': Record<string, never> | void;
}

/**
 * A strongly-typed in-process Event Bus for Jarvis OS.
 *
 * DESIGN DECISION: Local In-Process Events
 * In Phase 1, Jarvis runs as a single, isolated process. Wrapping the standard Node.js
 * EventEmitter keeps the bus simple and clean. If later phases require cross-process or
 * distributed event pub-sub (e.g. via NATS or Redis), this bus implementation can be replaced
 * without modifying callers.
 */
export class JarvisEventBus {
  private emitter = new EventEmitter();

  /**
   * Emits a typed event to all registered listeners.
   *
   * @param event The event key.
   * @param payload The strongly typed payload associated with the event.
   */
  emit<K extends keyof JarvisEvents>(event: K, payload?: JarvisEvents[K]): boolean {
    return this.emitter.emit(event, payload);
  }

  /**
   * Registers a callback handler for a typed event.
   *
   * @param event The event key.
   * @param handler Typed callback executing on event.
   */
  on<K extends keyof JarvisEvents>(event: K, handler: (payload: JarvisEvents[K]) => void): this {
    this.emitter.on(event, handler);
    return this;
  }

  /**
   * Unregisters a callback handler for a typed event.
   *
   * @param event The event key.
   * @param handler The handler callback function reference.
   */
  off<K extends keyof JarvisEvents>(event: K, handler: (payload: JarvisEvents[K]) => void): this {
    this.emitter.off(event, handler);
    return this;
  }
}
