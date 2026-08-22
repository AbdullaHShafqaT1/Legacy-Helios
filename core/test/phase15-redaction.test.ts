import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/lib/redact.js';

describe('Phase 15 Shannon Entropy Redaction tests', () => {
  it('does not redact natural English prose or long dictionary words (low false positive)', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. This is a normal paragraph discussing software architecture.';
    const longWord = 'The incomprehensibilities of the layout caused confusion, but floccinaucinihilipilification is not a secret.';
    
    // Natural English should retain its exact content
    expect(redactSecrets(prose)).toBe(prose);
    expect(redactSecrets(longWord)).toBe(longWord);
  });

  it('redacts high-entropy random keys, hashes, and tokens (high true positive)', () => {
    // 32-character random hex string (high entropy)
    const randomHex = 'd1f5e2a9c8b7f0e3d2c1b0a9f8e7d6c5';
    // 32-character random base64-ish token
    const randomToken = 'x9+f/G_78hK-LmNoPqRsTuVwXyZ12345';

    expect(redactSecrets(randomHex)).toBe('[REDACTED]');
    expect(redactSecrets(randomToken)).toBe('[REDACTED]');
  });

  it('maintains complementary behavior catching low-entropy matches with pattern regex', () => {
    // A fake Anthropic key that repeats characters (low entropy, around 1.5)
    // "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const lowEntropyKey = 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    
    // Should still be redacted because the regex matches the sk-ant- prefix
    expect(redactSecrets(lowEntropyKey)).toBe('[REDACTED]');
  });

  it('operates recursively on arrays, objects, and Error objects', () => {
    const data = {
      user: 'alice',
      secretKey: 'a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3', // high entropy
      notes: [
        'normal note',
        'token: z9+y8x7w6v5u4t3s2r1q0p9o8n7m6l5k' // high entropy
      ]
    };

    const redacted = redactSecrets(data) as any;
    expect(redacted.user).toBe('alice');
    expect(redacted.secretKey).toBe('[REDACTED]');
    expect(redacted.notes[0]).toBe('normal note');
    expect(redacted.notes[1]).toBe('token: [REDACTED]');
  });

  it('prints true/false positive precision metrics on a test corpus', () => {
    const naturalProseCorpus = [
      'This is a completely normal sentence.',
      'We are programming in TypeScript and Node.js.',
      'Antidisestablishmentarianism is a very long word.',
      'The database schema contains tasks, memory, and audit logs.',
      'Let us meet at the coordinate bounds (100, 200) tomorrow.'
    ];

    const secretCorpus = [
      'a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4', // 32-char hex
      'z9+y8x7w6v5u4t3s2r1q0p9o8n7m6l5k', // 32-char base64
      'sk-ant-1234567890abcdef1234567890abcdef', // Anthropic key
      'TOKEN_VALUE_ABC123_XYZ987_SEC_KEY_VAL', // Alphanumeric token
      '9977553311ccaabbddeeff0011223344' // another hex string
    ];

    let falsePositives = 0;
    for (const text of naturalProseCorpus) {
      if (redactSecrets(text) !== text) {
        falsePositives++;
      }
    }

    let truePositives = 0;
    for (const secret of secretCorpus) {
      if (redactSecrets(secret) === '[REDACTED]') {
        truePositives++;
      }
    }

    console.log('\n===== ENTROPY REDACTION PRECISION METRICS =====');
    console.log(`Natural prose corpus size:   ${naturalProseCorpus.length}`);
    console.log(`False positives detected:    ${falsePositives} (should be 0)`);
    console.log(`Secret corpus size:          ${secretCorpus.length}`);
    console.log(`True positives detected:     ${truePositives} (should be ${secretCorpus.length})`);
    console.log('================================================\n');

    expect(falsePositives).toBe(0);
    expect(truePositives).toBe(secretCorpus.length);
  });
});
