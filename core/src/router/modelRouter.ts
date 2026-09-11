export type TaskType = "coding" | "reasoning" | "research" | "vision";

export type ModelProviderName = 'ollama' | 'claude' | 'lmstudio' | 'gemini' | 'api_key' | 'custom_url' | (string & {});

export interface ModelRequestContext {
  description: string;
  fileContext?: unknown;
  image?: {
    base64: string;
    mediaType: string;
  };
  provider?: ModelProviderName;
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
  private activeProvider: ModelProviderName = 'ollama';

  /**
   * Registers a new route handler in the model router.
   *
   * @param route The route executor mapping to supported task types.
   */
  register(route: ModelRoute): void {
    this.routes.push(route);
  }

  /**
   * Unregisters route handlers matching a predicate.
   */
  unregister(predicate: (route: ModelRoute) => boolean): void {
    this.routes = this.routes.filter((r) => !predicate(r));
  }

  /**
   * Replaces or registers a route handler by constructor name.
   */
  upsertRoute(route: ModelRoute): void {
    const className = route.constructor.name;
    this.routes = this.routes.filter((r) => r.constructor.name !== className);
    this.routes.push(route);
  }

  /**
   * Sets the globally active provider for the agent orchestration layer.
   */
  setActiveProvider(provider: ModelProviderName): void {
    this.activeProvider = provider;
  }

  /**
   * Gets the currently active provider.
   */
  getActiveProvider(): ModelProviderName {
    return this.activeProvider;
  }

  /**
   * Returns all currently registered routes.
   */
  getRoutes(): ModelRoute[] {
    return [...this.routes];
  }

  /**
   * Resolves a route for a given provider name and task type.
   */
  private findRouteForProvider(provider: ModelProviderName, taskType: TaskType): ModelRoute | undefined {
    if (provider === 'ollama') {
      return this.routes.find(r => r.taskTypes.includes(taskType) && r.constructor.name === 'OllamaConnector');
    }
    if (provider === 'lmstudio') {
      return this.routes.find(r => r.taskTypes.includes(taskType) && r.constructor.name === 'LMStudioConnector');
    }
    if (provider === 'gemini' || provider === 'api_key') {
      return this.routes.find(r => r.taskTypes.includes(taskType) && (r.constructor.name === 'GeminiConnector' || r.constructor.name === 'ClaudeConnector'));
    }
    if (provider === 'claude') {
      return this.routes.find(r => r.taskTypes.includes(taskType) && r.constructor.name === 'ClaudeConnector');
    }
    if (provider === 'custom_url') {
      return this.routes.find(r => r.taskTypes.includes(taskType) && r.constructor.name === 'CustomUrlConnector');
    }
    return this.routes.find(r => r.taskTypes.includes(taskType) && r.constructor.name.toLowerCase().includes(provider.toLowerCase()));
  }

  /**
   * Routes a request to the first registered route capable of handling the task type.
   * Matches preferred provider if specified, otherwise uses active provider.
   *
   * @param taskType The type of LLM processing required.
   * @param context The request parameters.
   * @returns A promise resolving to the model response.
   * @throws ModelRouterError if no capable route handler is registered.
   */
  async route(taskType: TaskType, context: ModelRequestContext): Promise<ModelResponse> {
    let route: ModelRoute | undefined;

    const targetProvider = context.provider || this.activeProvider;

    if (targetProvider) {
      route = this.findRouteForProvider(targetProvider, taskType);
    }

    if (!route) {
      // Fallback: search by activeProvider, then Ollama, then any capable route
      route = this.findRouteForProvider(this.activeProvider, taskType)
           || this.routes.find(r => r.taskTypes.includes(taskType) && r.constructor.name === 'OllamaConnector')
           || this.routes.find(r => r.taskTypes.includes(taskType));
    }
    
    if (!route) {
      throw new ModelRouterError(`No registered model route matches task type "${taskType}".`);
    }

    return route.invoke(context);
  }
}

