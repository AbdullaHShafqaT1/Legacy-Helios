import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStdinApprovalPrompt } from '../src/lib/prompt.js';
import { stdin } from 'node:process';

describe('createStdinApprovalPrompt TTY fallback', () => {
  let isTTYBackup: boolean | undefined;

  beforeEach(() => {
    isTTYBackup = stdin.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(stdin, 'isTTY', {
      value: isTTYBackup,
      configurable: true,
      writable: true,
    });
  });

  it('should resolve to false immediately when stdin.isTTY is false', async () => {
    // Force isTTY to false
    Object.defineProperty(stdin, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });

    const prompt = createStdinApprovalPrompt();
    const result = await prompt({
      actor: 'test-actor',
      action: 'file-write',
      params: { path: '/some/path' }
    });

    expect(result).toBe(false);
  });
});
