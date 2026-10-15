import { describe, expect, it } from 'vitest';
import { readStdioToken, TOKEN_ENV_VAR } from '../src/stdio.js';

describe('readStdioToken', () => {
  it('reads SALLA_ACCESS_TOKEN from the provided environment', () => {
    expect(TOKEN_ENV_VAR).toBe('SALLA_ACCESS_TOKEN');
    expect(readStdioToken({ SALLA_ACCESS_TOKEN: '  tok-123  ' })).toBe('tok-123');
  });

  it('fails fast with a clear message when missing or blank', () => {
    expect(() => readStdioToken({})).toThrow(/SALLA_ACCESS_TOKEN is not set/);
    expect(() => readStdioToken({ SALLA_ACCESS_TOKEN: ' ' })).toThrow(/never reads \.env/);
  });
});
