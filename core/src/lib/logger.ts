import pino from 'pino';

/**
 * Creates a structured JSON Pino logger.
 * Configured with key redaction to protect against API key or credential leakage in logs.
 * 
 * @param name The name of the logger module.
 * @param level Optional override for log level.
 * @returns A configured Pino logger instance.
 */
export function createLogger(name: string, level?: string) {
  const finalLevel = level || process.env.JARVIS_LOG_LEVEL || 'info';
  
  return pino({
    name,
    level: finalLevel,
    redact: {
      // NOTE: redactSecrets() in redact.ts is the primary mechanism for nested logs and custom parameters.
      paths: [
        // Top-level property keys
        'anthropicApiKey',
        'apiKey',
        'api_key',
        'api-key',
        'secret',
        'password',
        'token',
        'authorization',
        'headers.authorization',
        'headers.x-api-key',
        'headers.api-key',
        'headers.anthropic-api-key',
        
        // Single-level nested keys
        '*.anthropicApiKey',
        '*.apiKey',
        '*.api_key',
        '*.api-key',
        '*.secret',
        '*.password',
        '*.token',
        '*.authorization',
        '*.headers.authorization',
        '*.headers.x-api-key',
        '*.headers.api-key',
        '*.headers.anthropic-api-key',
        
        // Two-level nested keys (e.g. error.config.headers.authorization)
        '*.*.anthropicApiKey',
        '*.*.apiKey',
        '*.*.api_key',
        '*.*.api-key',
        '*.*.secret',
        '*.*.password',
        '*.*.token',
        '*.*.authorization',
        '*.*.headers.authorization',
        '*.*.headers.x-api-key',
        '*.*.headers.api-key',
        '*.*.headers.anthropic-api-key',

        // Three-level nested keys
        '*.*.*.anthropicApiKey',
        '*.*.*.apiKey',
        '*.*.*.api_key',
        '*.*.*.api-key',
        '*.*.*.secret',
        '*.*.*.password',
        '*.*.*.token',
        '*.*.*.authorization',
        '*.*.*.headers.authorization',
        '*.*.*.headers.x-api-key',
        '*.*.*.headers.api-key',
        '*.*.*.headers.anthropic-api-key',
      ],
      censor: '[REDACTED]',
    },
  });
}
