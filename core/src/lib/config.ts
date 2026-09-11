import dotenv from 'dotenv';
import path from 'node:path';

/**
 * Custom error thrown when the configuration is invalid or missing required variables.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/**
 * Interface representing the validated configurations for Jarvis.
 */
export interface Config {
  anthropicApiKey?: string;
  dbPath: string;
  model: string;
  maxRetries: number;
  pollIntervalMs: number;
  staleTaskTimeoutMs: number;
  logLevel: string;
  approvalTimeoutMs: number;
  projectRoot: string;
  vectorStorePath: string;
  vectorStoreType: string;
  embeddingDimensions: number;
  memoryMaxEntries: number;
  messageTimeoutMs?: number;
  kanbanDefaultBoardId?: string;
  kanbanDefaultBoardName?: string;
  browserHeadless: boolean;
  browserLocalAllowlist: string[];
  terminalAllowlist: string[];
  terminalTimeoutMs: number;
  claudeTimeoutMs: number;
  unattended: boolean;
  voiceWakeWordThreshold: number;
  voiceSttConfidenceThreshold: number;
  voiceTtsRate: number;
  voiceWakeWordModelPath: string;
  voiceSttModelPath: string;
  voiceAudioInputDevice: string;
  voiceAudioOutputDevice: string;
  voiceAudioSampleRate: number;
  voiceCiFallback: boolean;
  visionEnabled: boolean;
  visionPreferredDisplay: number;
  visionCaptureTimeoutMs: number;
  visionProvider: string;
  visionOcrEnabled: boolean;
  healthCheckIntervalMs: number;
  restartLimits: number;
  restartBackoffMs: number;
  desktopControlEnabled: boolean;
  desktopActionTimeoutMs: number;
  desktopObservationMaxAgeMs: number;
  desktopMaxTextLength: number;
  desktopMaxActionsPerSequence: number;
  desktopRequireConfirmation: boolean;
  voiceWakeWordEngine: string;
  voicePorcupineAccessKey?: string;
  visionPeriodicIntervalMs: number;
  visionPeriodicRetentionMax: number;
  searchProvider: string;
  searchApiKey?: string;
  searchRateLimitCount: number;
  searchRateLimitWindowMs: number;
  voiceDuplexPort: number;
  voiceDuplexInterruptThreshold: number;
  voiceDuplexModelType: 'local' | 'cloud';
  dashboardPort: number;
  activeModelProvider?: 'ollama' | 'lmstudio' | 'api_key' | 'custom_url';
  ollamaModel?: string;
  ollamaBaseUrl?: string;
  lmstudioModel?: string;
  lmstudioBaseUrl?: string;
  geminiApiKey?: string;
  customEndpointUrl?: string;
}

export interface ModelRuntimeState {
  provider: 'ollama' | 'lmstudio' | 'api_key' | 'custom_url';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  customUrl?: string;
}

let runtimeModelConfig: ModelRuntimeState = {
  provider: 'ollama',
  model: 'llava:latest',
  baseUrl: 'http://localhost:11434',
};

/**
 * Retrieves the current runtime model configuration.
 */
export function getRuntimeModelConfig(): ModelRuntimeState {
  return { ...runtimeModelConfig };
}

/**
 * Updates the active runtime model configuration for the agent orchestration layer.
 */
export function updateRuntimeModelConfig(update: Partial<ModelRuntimeState>): ModelRuntimeState {
  runtimeModelConfig = {
    ...runtimeModelConfig,
    ...update,
  };
  if (cachedConfig) {
    if (update.provider) cachedConfig.activeModelProvider = update.provider;
    if (update.model) cachedConfig.model = update.model;
    if (update.apiKey) cachedConfig.geminiApiKey = update.apiKey;
    if (update.customUrl) cachedConfig.customEndpointUrl = update.customUrl;
  }
  return { ...runtimeModelConfig };
}

let cachedConfig: Config | null = null;

/**
 * Clears the configuration cache. Primarily used in unit tests.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Loads the environment variables, applies sensible defaults, and validates them.
 * 
 * @param requireApiKey If true, throws a ConfigError if ANTHROPIC_API_KEY is missing/empty.
 * @returns The validated configurations.
 * @throws ConfigError synchronously if required configurations are invalid or missing.
 */
export function loadConfig(requireApiKey = true): Config {
  if (cachedConfig) {
    if (requireApiKey && (!cachedConfig.anthropicApiKey || cachedConfig.anthropicApiKey.trim() === '')) {
      throw new ConfigError('ANTHROPIC_API_KEY environment variable is required but was not provided.');
    }
    return cachedConfig;
  }

  // Load env variables
  dotenv.config();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (requireApiKey && (!apiKey || apiKey.trim() === '')) {
    throw new ConfigError('ANTHROPIC_API_KEY environment variable is required but was not provided.');
  }

  const dbPath = process.env.JARVIS_DB_PATH || 'memory-store/jarvis.db';
  const model = process.env.JARVIS_MODEL || 'claude-sonnet-4-6';
  const logLevel = process.env.JARVIS_LOG_LEVEL || 'info';

  const maxRetriesStr = process.env.JARVIS_MAX_RETRIES || '3';
  const maxRetries = parseInt(maxRetriesStr, 10);
  if (isNaN(maxRetries)) {
    throw new ConfigError(`Invalid value for JARVIS_MAX_RETRIES: "${maxRetriesStr}" is not a valid number.`);
  }

  const pollIntervalMsStr = process.env.JARVIS_POLL_INTERVAL_MS || '5000';
  const pollIntervalMs = parseInt(pollIntervalMsStr, 10);
  if (isNaN(pollIntervalMs)) {
    throw new ConfigError(`Invalid value for JARVIS_POLL_INTERVAL_MS: "${pollIntervalMsStr}" is not a valid number.`);
  }

  const staleTaskTimeoutMsStr = process.env.JARVIS_STALE_TASK_TIMEOUT_MS || '300000';
  const staleTaskTimeoutMs = parseInt(staleTaskTimeoutMsStr, 10);
  if (isNaN(staleTaskTimeoutMs)) {
    throw new ConfigError(`Invalid value for JARVIS_STALE_TASK_TIMEOUT_MS: "${staleTaskTimeoutMsStr}" is not a valid number.`);
  }

  const approvalTimeoutMsStr = process.env.JARVIS_APPROVAL_TIMEOUT_MS || '30000';
  const approvalTimeoutMs = parseInt(approvalTimeoutMsStr, 10);
  if (isNaN(approvalTimeoutMs)) {
    throw new ConfigError(`Invalid value for JARVIS_APPROVAL_TIMEOUT_MS: "${approvalTimeoutMsStr}" is not a valid number.`);
  }

  const projectRootEnv = process.env.JARVIS_PROJECT_ROOT || process.cwd();
  const projectRoot = path.resolve(projectRootEnv.trim());

  const vectorStorePath = process.env.JARVIS_VECTOR_STORE_PATH || 'memory-store/vectors.db';
  const vectorStoreType = process.env.JARVIS_VECTOR_STORE_TYPE || 'sqlite-json-cosine';
  const embeddingDimensionsStr = process.env.JARVIS_EMBEDDING_DIMENSIONS || '384';
  const embeddingDimensions = parseInt(embeddingDimensionsStr, 10);
  if (isNaN(embeddingDimensions) || embeddingDimensions <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_EMBEDDING_DIMENSIONS: "${embeddingDimensionsStr}" is not a valid positive number.`);
  }

  const memoryMaxEntriesStr = process.env.JARVIS_MEMORY_MAX_ENTRIES || '1000';
  const memoryMaxEntries = parseInt(memoryMaxEntriesStr, 10);
  if (isNaN(memoryMaxEntries) || memoryMaxEntries <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_MEMORY_MAX_ENTRIES: "${memoryMaxEntriesStr}" is not a valid positive number.`);
  }

  const messageTimeoutMsStr = process.env.JARVIS_MESSAGE_TIMEOUT_MS || '10000';
  const messageTimeoutMs = parseInt(messageTimeoutMsStr, 10);
  if (isNaN(messageTimeoutMs) || messageTimeoutMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_MESSAGE_TIMEOUT_MS: "${messageTimeoutMsStr}" is not a valid positive number.`);
  }

  const kanbanDefaultBoardId = process.env.JARVIS_KANBAN_DEFAULT_BOARD_ID || 'default-board';
  const kanbanDefaultBoardName = process.env.JARVIS_KANBAN_DEFAULT_BOARD_NAME || 'Default Board';

  const browserHeadless = process.env.JARVIS_BROWSER_HEADLESS !== 'false';
  const browserLocalAllowlist = (process.env.JARVIS_BROWSER_LOCAL_ALLOWLIST || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const terminalAllowlist = (process.env.JARVIS_TERMINAL_ALLOWLIST || 'ls,git status,npm test')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const terminalTimeoutMsStr = process.env.JARVIS_TERMINAL_TIMEOUT_MS || '30000';
  const terminalTimeoutMs = parseInt(terminalTimeoutMsStr, 10);
  if (isNaN(terminalTimeoutMs) || terminalTimeoutMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_TERMINAL_TIMEOUT_MS: "${terminalTimeoutMsStr}" is not a valid positive number.`);
  }

  const claudeTimeoutMsStr = process.env.JARVIS_CLAUDE_TIMEOUT_MS || '60000';
  const claudeTimeoutMs = parseInt(claudeTimeoutMsStr, 10);
  if (isNaN(claudeTimeoutMs) || claudeTimeoutMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_CLAUDE_TIMEOUT_MS: "${claudeTimeoutMsStr}" is not a valid positive number.`);
  }

  const unattended = process.env.JARVIS_UNATTENDED === 'true';

  const voiceWakeWordThresholdStr = process.env.JARVIS_WAKE_WORD_THRESHOLD || process.env.JARVIS_WAKE_WORD_SENSITIVITY || '0.1';
  const voiceWakeWordThreshold = parseFloat(voiceWakeWordThresholdStr);
  if (isNaN(voiceWakeWordThreshold)) {
    throw new ConfigError(`Invalid value for JARVIS_WAKE_WORD_THRESHOLD: "${voiceWakeWordThresholdStr}" is not a valid number.`);
  }

  const voiceSttConfidenceThresholdStr = process.env.JARVIS_STT_CONFIDENCE_THRESHOLD || '0.8';
  const voiceSttConfidenceThreshold = parseFloat(voiceSttConfidenceThresholdStr);
  if (isNaN(voiceSttConfidenceThreshold)) {
    throw new ConfigError(`Invalid value for JARVIS_STT_CONFIDENCE_THRESHOLD: "${voiceSttConfidenceThresholdStr}" is not a valid number.`);
  }

  const voiceTtsRateStr = process.env.JARVIS_TTS_RATE || '175';
  const voiceTtsRate = parseInt(voiceTtsRateStr, 10);
  if (isNaN(voiceTtsRate)) {
    throw new ConfigError(`Invalid value for JARVIS_TTS_RATE: "${voiceTtsRateStr}" is not a valid number.`);
  }

  // Objective 6: Gated speech configurations
  const voiceWakeWordModelPath = process.env.JARVIS_WAKE_WORD_MODEL_PATH || '';
  const voiceSttModelPath = process.env.JARVIS_STT_MODEL_PATH || '';
  const voiceAudioInputDevice = process.env.JARVIS_AUDIO_INPUT_DEVICE || '';
  const voiceAudioOutputDevice = process.env.JARVIS_AUDIO_OUTPUT_DEVICE || '';

  const voiceAudioSampleRateStr = process.env.JARVIS_AUDIO_SAMPLE_RATE || '16000';
  const voiceAudioSampleRate = parseInt(voiceAudioSampleRateStr, 10);
  if (isNaN(voiceAudioSampleRate) || voiceAudioSampleRate <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_AUDIO_SAMPLE_RATE: "${voiceAudioSampleRateStr}" is not a valid positive number.`);
  }

  const voiceCiFallback = process.env.JARVIS_CI_FALLBACK === 'true';

  const voiceWakeWordEngine = process.env.JARVIS_WAKE_WORD_ENGINE || 'openwakeword';
  const voicePorcupineAccessKey = process.env.JARVIS_PORCUPINE_ACCESS_KEY || '';

  const visionPeriodicIntervalMsStr = process.env.JARVIS_PERIODIC_CAPTURE_INTERVAL_MS || '10000';
  const visionPeriodicIntervalMs = parseInt(visionPeriodicIntervalMsStr, 10);
  if (isNaN(visionPeriodicIntervalMs) || visionPeriodicIntervalMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_PERIODIC_CAPTURE_INTERVAL_MS: "${visionPeriodicIntervalMsStr}" must be a positive integer.`);
  }

  const visionPeriodicRetentionMaxStr = process.env.JARVIS_PERIODIC_CAPTURE_RETENTION_MAX || '15';
  const visionPeriodicRetentionMax = parseInt(visionPeriodicRetentionMaxStr, 10);
  if (isNaN(visionPeriodicRetentionMax) || visionPeriodicRetentionMax <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_PERIODIC_CAPTURE_RETENTION_MAX: "${visionPeriodicRetentionMaxStr}" must be a positive integer.`);
  }

  const searchProvider = process.env.JARVIS_SEARCH_PROVIDER || 'duckduckgo';
  const searchApiKey = process.env.JARVIS_TAVILY_API_KEY || '';

  const searchRateLimitCountStr = process.env.JARVIS_SEARCH_RATE_LIMIT_COUNT || '10';
  const searchRateLimitCount = parseInt(searchRateLimitCountStr, 10);
  if (isNaN(searchRateLimitCount) || searchRateLimitCount <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_SEARCH_RATE_LIMIT_COUNT: "${searchRateLimitCountStr}" must be a positive integer.`);
  }

  const searchRateLimitWindowMsStr = process.env.JARVIS_SEARCH_RATE_LIMIT_WINDOW_MS || '60000';
  const searchRateLimitWindowMs = parseInt(searchRateLimitWindowMsStr, 10);
  if (isNaN(searchRateLimitWindowMs) || searchRateLimitWindowMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_SEARCH_RATE_LIMIT_WINDOW_MS: "${searchRateLimitWindowMsStr}" must be a positive integer.`);
  }

  const voiceDuplexPortStr = process.env.JARVIS_DUPLEX_PORT || '8085';
  const voiceDuplexPort = parseInt(voiceDuplexPortStr, 10);
  if (isNaN(voiceDuplexPort) || voiceDuplexPort <= 0 || voiceDuplexPort > 65535) {
    throw new ConfigError(`Invalid value for JARVIS_DUPLEX_PORT: "${voiceDuplexPortStr}" is not a valid port number.`);
  }

  const voiceDuplexInterruptThresholdStr = process.env.JARVIS_DUPLEX_INTERRUPT_THRESHOLD || '0.02';
  const voiceDuplexInterruptThreshold = parseFloat(voiceDuplexInterruptThresholdStr);
  if (isNaN(voiceDuplexInterruptThreshold) || voiceDuplexInterruptThreshold <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_DUPLEX_INTERRUPT_THRESHOLD: "${voiceDuplexInterruptThresholdStr}" must be a positive float.`);
  }

  const voiceDuplexModelType = (process.env.JARVIS_DUPLEX_MODEL_TYPE || 'local') as 'local' | 'cloud';
  if (voiceDuplexModelType !== 'local' && voiceDuplexModelType !== 'cloud') {
    throw new ConfigError(`Invalid value for JARVIS_DUPLEX_MODEL_TYPE: "${voiceDuplexModelType}" must be 'local' or 'cloud'.`);
  }

  const dashboardPortStr = process.env.JARVIS_DASHBOARD_PORT || '8086';
  const dashboardPort = parseInt(dashboardPortStr, 10);
  if (isNaN(dashboardPort) || dashboardPort <= 0 || dashboardPort > 65535) {
    throw new ConfigError(`Invalid value for JARVIS_DASHBOARD_PORT: "${dashboardPortStr}" is not a valid port number.`);
  }

  const visionEnabled = process.env.JARVIS_VISION_ENABLED !== 'false';
  
  const visionPreferredDisplayStr = process.env.JARVIS_VISION_PREFERRED_DISPLAY || '0';
  const visionPreferredDisplay = parseInt(visionPreferredDisplayStr, 10);
  if (isNaN(visionPreferredDisplay) || visionPreferredDisplay < 0) {
    throw new ConfigError(`Invalid value for JARVIS_VISION_PREFERRED_DISPLAY: "${visionPreferredDisplayStr}" must be a non-negative integer.`);
  }

  const visionCaptureTimeoutMsStr = process.env.JARVIS_VISION_CAPTURE_TIMEOUT_MS || '10000';
  const visionCaptureTimeoutMs = parseInt(visionCaptureTimeoutMsStr, 10);
  if (isNaN(visionCaptureTimeoutMs) || visionCaptureTimeoutMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_VISION_CAPTURE_TIMEOUT_MS: "${visionCaptureTimeoutMsStr}" must be a positive integer.`);
  }

  const visionProvider = process.env.JARVIS_VISION_PROVIDER || 'claude';
  const visionOcrEnabled = process.env.JARVIS_VISION_OCR_ENABLED !== 'false';

  const healthCheckIntervalMsStr = process.env.JARVIS_HEALTH_CHECK_INTERVAL_MS || '30000';
  const healthCheckIntervalMs = parseInt(healthCheckIntervalMsStr, 10);
  if (isNaN(healthCheckIntervalMs) || healthCheckIntervalMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_HEALTH_CHECK_INTERVAL_MS: "${healthCheckIntervalMsStr}" must be a positive integer.`);
  }

  const restartLimitsStr = process.env.JARVIS_RESTART_LIMITS || '3';
  const restartLimits = parseInt(restartLimitsStr, 10);
  if (isNaN(restartLimits) || restartLimits < 0) {
    throw new ConfigError(`Invalid value for JARVIS_RESTART_LIMITS: "${restartLimitsStr}" must be a non-negative integer.`);
  }

  const restartBackoffMsStr = process.env.JARVIS_RESTART_BACKOFF_MS || '5000';
  const restartBackoffMs = parseInt(restartBackoffMsStr, 10);
  if (isNaN(restartBackoffMs) || restartBackoffMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_RESTART_BACKOFF_MS: "${restartBackoffMsStr}" must be a positive integer.`);
  }

  const desktopControlEnabled = process.env.JARVIS_DESKTOP_CONTROL_ENABLED !== 'false';
  
  const desktopActionTimeoutMsStr = process.env.JARVIS_DESKTOP_ACTION_TIMEOUT_MS || '10000';
  const desktopActionTimeoutMs = parseInt(desktopActionTimeoutMsStr, 10);
  if (isNaN(desktopActionTimeoutMs) || desktopActionTimeoutMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_DESKTOP_ACTION_TIMEOUT_MS: "${desktopActionTimeoutMsStr}" must be a positive integer.`);
  }

  const desktopObservationMaxAgeMsStr = process.env.JARVIS_DESKTOP_OBSERVATION_MAX_AGE_MS || '60000';
  const desktopObservationMaxAgeMs = parseInt(desktopObservationMaxAgeMsStr, 10);
  if (isNaN(desktopObservationMaxAgeMs) || desktopObservationMaxAgeMs <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_DESKTOP_OBSERVATION_MAX_AGE_MS: "${desktopObservationMaxAgeMsStr}" must be a positive integer.`);
  }

  const desktopMaxTextLengthStr = process.env.JARVIS_DESKTOP_MAX_TEXT_LENGTH || '500';
  const desktopMaxTextLength = parseInt(desktopMaxTextLengthStr, 10);
  if (isNaN(desktopMaxTextLength) || desktopMaxTextLength <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_DESKTOP_MAX_TEXT_LENGTH: "${desktopMaxTextLengthStr}" must be a positive integer.`);
  }

  const desktopMaxActionsPerSequenceStr = process.env.JARVIS_DESKTOP_MAX_ACTIONS_PER_SEQUENCE || '20';
  const desktopMaxActionsPerSequence = parseInt(desktopMaxActionsPerSequenceStr, 10);
  if (isNaN(desktopMaxActionsPerSequence) || desktopMaxActionsPerSequence <= 0) {
    throw new ConfigError(`Invalid value for JARVIS_DESKTOP_MAX_ACTIONS_PER_SEQUENCE: "${desktopMaxActionsPerSequenceStr}" must be a positive integer.`);
  }

  const desktopRequireConfirmation = process.env.JARVIS_DESKTOP_REQUIRE_CONFIRMATION !== 'false';

  cachedConfig = {
    anthropicApiKey: apiKey ? apiKey.trim() : undefined,
    dbPath: dbPath.trim(),
    model: model.trim(),
    maxRetries,
    pollIntervalMs,
    staleTaskTimeoutMs,
    logLevel: logLevel.trim(),
    approvalTimeoutMs,
    projectRoot,
    vectorStorePath: vectorStorePath.trim(),
    vectorStoreType: vectorStoreType.trim(),
    embeddingDimensions,
    memoryMaxEntries,
    messageTimeoutMs,
    kanbanDefaultBoardId: kanbanDefaultBoardId.trim(),
    kanbanDefaultBoardName: kanbanDefaultBoardName.trim(),
    browserHeadless,
    browserLocalAllowlist,
    terminalAllowlist,
    terminalTimeoutMs,
    claudeTimeoutMs,
    unattended,
    voiceWakeWordThreshold,
    voiceSttConfidenceThreshold,
    voiceTtsRate,
    voiceWakeWordModelPath,
    voiceSttModelPath,
    voiceAudioInputDevice,
    voiceAudioOutputDevice,
    voiceAudioSampleRate,
    voiceCiFallback,
    visionEnabled,
    visionPreferredDisplay,
    visionCaptureTimeoutMs,
    visionProvider,
    visionOcrEnabled,
    healthCheckIntervalMs,
    restartLimits,
    restartBackoffMs,
    desktopControlEnabled,
    desktopActionTimeoutMs,
    desktopObservationMaxAgeMs,
    desktopMaxTextLength,
    desktopMaxActionsPerSequence,
    desktopRequireConfirmation,
    voiceWakeWordEngine,
    voicePorcupineAccessKey,
    visionPeriodicIntervalMs,
    visionPeriodicRetentionMax,
    searchProvider,
    searchApiKey,
    searchRateLimitCount,
    searchRateLimitWindowMs,
    voiceDuplexPort,
    voiceDuplexInterruptThreshold,
    voiceDuplexModelType,
    dashboardPort,
    activeModelProvider: (process.env.JARVIS_MODEL_PROVIDER as any) || 'ollama',
    ollamaModel: process.env.JARVIS_OLLAMA_MODEL || 'llava:latest',
    ollamaBaseUrl: process.env.JARVIS_OLLAMA_BASE_URL || 'http://localhost:11434',
    lmstudioModel: process.env.JARVIS_LMSTUDIO_MODEL || 'local-model',
    lmstudioBaseUrl: process.env.JARVIS_LMSTUDIO_BASE_URL || 'http://localhost:1234',
    geminiApiKey: process.env.GEMINI_API_KEY || process.env.JARVIS_GEMINI_API_KEY || '',
    customEndpointUrl: process.env.JARVIS_CUSTOM_ENDPOINT_URL || '',
  };

  return cachedConfig;
}
