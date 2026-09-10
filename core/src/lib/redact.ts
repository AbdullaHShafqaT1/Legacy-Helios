/**
 * Recursively redacts sensitive values (like API keys, passwords, and tokens) from
 * objects, arrays, error objects, and string fields.
 *
 * @param value The value to redact.
 * @returns A new object or array with redacted values, or the original value if it is primitive/null.
 */
export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle strings: replace any raw Anthropic API key patterns to prevent leak
  if (typeof value === 'string') {
    let redacted = value.replace(/sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED]');

    const threshold = parseFloat(process.env.JARVIS_REDACTION_ENTROPY_THRESHOLD || '3.7');
    const tokenRegex = /[a-zA-Z0-9_\-\/\+=]{16,128}/g;

    redacted = redacted.replace(tokenRegex, (token) => {
      const entropy = calculateShannonEntropy(token);
      if (entropy >= threshold) {
        return '[REDACTED]';
      }
      return token;
    });

    return redacted;
  }

  // Return primitive values as-is
  if (typeof value !== 'object') {
    return value;
  }

  // Handle arrays recursively
  if (Array.isArray(value)) {
    return value.map(item => redactSecrets(item));
  }

  // Handle standard Error instances (copy message, stack, and enumerable fields recursively)
  if (value instanceof Error) {
    const errorCopy = new Error(redactSecrets(value.message) as string);
    errorCopy.name = value.name;
    if (value.stack) {
      errorCopy.stack = redactSecrets(value.stack) as string;
    }
    // Copy any custom/nested error attributes
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === 'message' || key === 'stack' || key === 'name') continue;
      const val = (value as any)[key];
      const keyRegex = /api[_-]?key|token|secret|password|authorization/i;
      if (keyRegex.test(key)) {
        (errorCopy as any)[key] = '[REDACTED]';
      } else {
        (errorCopy as any)[key] = redactSecrets(val);
      }
    }
    return errorCopy;
  }

  // Handle standard objects recursively
  const result: Record<string, any> = {};
  const keyRegex = /api[_-]?key|token|secret|password|authorization/i;

  for (const key of Object.keys(value)) {
    const val = (value as Record<string, any>)[key];
    if (keyRegex.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSecrets(val);
    }
  }

  return result;
}

function calculateShannonEntropy(str: string): number {
  if (!str) return 0;
  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
