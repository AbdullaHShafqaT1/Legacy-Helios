import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/lib/redact.js';

describe('redactSecrets Utility', () => {
  it('should return null, undefined, or primitives as-is', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets('hello')).toBe('hello');
  });

  it('should redact top-level secrets case-insensitively', () => {
    const data = {
      apiKey: 'sk-ant-12345',
      some_token: 'secret-token',
      unrelated: 'safe-value'
    };
    const redacted = redactSecrets(data) as any;
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.some_token).toBe('[REDACTED]');
    expect(redacted.unrelated).toBe('safe-value');
  });

  it('should redact nested secrets deeply (4+ levels deep)', () => {
    const nested = {
      level1: {
        level2: {
          level3: {
            level4: {
              password: 'super-secret-password',
              token: 'sub-token',
              safe: 'clean'
            }
          }
        }
      }
    };
    const redacted = redactSecrets(nested) as any;
    expect(redacted.level1.level2.level3.level4.password).toBe('[REDACTED]');
    expect(redacted.level1.level2.level3.level4.token).toBe('[REDACTED]');
    expect(redacted.level1.level2.level3.level4.safe).toBe('clean');
  });

  it('should match regex case-insensitively and handle underscores/dashes', () => {
    const data = {
      'api-key': 'val1',
      'API_KEY': 'val2',
      'Authorization': 'Bearer test',
      'MY_secret_KEY': 'val3',
      'password': 'val4'
    };
    const redacted = redactSecrets(data) as any;
    expect(redacted['api-key']).toBe('[REDACTED]');
    expect(redacted['API_KEY']).toBe('[REDACTED]');
    expect(redacted['Authorization']).toBe('[REDACTED]');
    expect(redacted['password']).toBe('[REDACTED]');
    expect(redacted['MY_secret_KEY']).toBe('[REDACTED]');
  });

  it('should redact raw Anthropic API key patterns in general string properties (like stacks or messages)', () => {
    const errorInfo = {
      message: 'Failed to access model with key sk-ant-123456789abcde',
      stack: 'Error: details\n at call (sdk.js)\n with key: sk-ant-987654321_key',
      safeMessage: 'All clear here'
    };
    const redacted = redactSecrets(errorInfo) as any;
    expect(redacted.message).toBe('Failed to access model with key [REDACTED]');
    expect(redacted.stack).toBe('Error: details\n at call (sdk.js)\n with key: [REDACTED]');
    expect(redacted.safeMessage).toBe('All clear here');
  });

  it('should redact attributes inside standard Error objects correctly', () => {
    const error = new Error('Database connection failed');
    (error as any).apiKey = 'secret-key-123';
    (error as any).unrelatedField = 'all-good';

    const redacted = redactSecrets(error) as any;
    expect(redacted.message).toBe('Database connection failed');
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.unrelatedField).toBe('all-good');
    expect(redacted instanceof Error).toBe(true);
  });
});
