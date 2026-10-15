import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';
import { TEST_TOKEN } from './helpers.js';

describe('redact', () => {
  it('removes bearer tokens and explicit secrets', () => {
    expect(redact(`Authorization: Bearer ${TEST_TOKEN}`)).not.toContain(TEST_TOKEN);
    expect(redact(`token was ${TEST_TOKEN}`, [TEST_TOKEN])).toBe('token was [REDACTED]');
  });

  it('removes token-like fields in JSON and query strings', () => {
    expect(redact({ access_token: 'abc123', ok: 1 })).toBe('{"access_token":"[REDACTED]","ok":1}');
    expect(redact('https://x/?access_token=abc123&a=1')).toBe('https://x/?access_token=[REDACTED]&a=1');
  });

  it('handles errors, short secrets and unserialisable values', () => {
    expect(redact(new Error(`bad Bearer ${TEST_TOKEN}`))).toBe('Error: bad Bearer [REDACTED]');
    expect(redact('the cat', ['cat'])).toBe('the cat');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redact(circular)).toBe('[object Object]');
    expect(redact(undefined)).toBe('undefined');
  });
});
