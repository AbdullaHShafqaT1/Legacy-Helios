export type TaskType = "coding" | "reasoning";

export interface ModelRequestContext {
  description: string;
  fileContext?: unknown;
}

export interface ModelResponse {
  text: string;
  raw?: unknown;
}

export interface ModelRoute {
  taskTypes: TaskType[];
  invoke(context: ModelRequestContext): Promise<ModelResponse>;
}

export class ModelRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRouterError';
    Object.setPrototypeOf(this, ModelRouterError.prototype);
  }
}

export class ModelRouter {
  private routes: ModelRoute[] = [];

  /**
   * Registers a new route handler in the model router.
   *
   * @param route The route executor mapping to supported task types.
   */
  register(route: ModelRoute): void {
    this.routes.push(route);
  }

  /**
   * Routes a request to the first registered route capable of handling the task type.
   *
   * @param taskType The type of LLM processing required.
   * @param context The request parameters.
   * @returns A promise resolving to the model response.
   * @throws ModelRouterError if no capable route handler is registered.
   */
  async route(taskType: TaskType, context: ModelRequestContext): Promise<ModelResponse> {
    const route = this.routes.find(r => r.taskTypes.includes(taskType));
    
    if (!route) {
      throw new ModelRouterError(`No registered model route matches task type "${taskType}".`);
    }

    return route.invoke(context);
  }
}
