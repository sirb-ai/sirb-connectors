import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/args.js';

describe('parseCliArgs', () => {
  it('defaults to stdio', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'stdio' });
    expect(parseCliArgs(['--stdio'])).toEqual({ mode: 'stdio' });
  });

  it('parses http with loopback defaults', () => {
    expect(parseCliArgs(['--http'])).toEqual({ mode: 'http', host: '127.0.0.1', port: 3000 });
    expect(parseCliArgs(['--http', '--port', '8080', '--host', '::1'])).toEqual({
      mode: 'http',
      host: '::1',
      port: 8080,
    });
  });

  it('parses help', () => {
    expect(parseCliArgs(['-h'])).toEqual({ mode: 'help' });
  });

  it.each([
    [['--http', '--stdio'], /either/],
    [['--port', '1'], /only valid with --http/],
    [['--http', '--port', '70000'], /Invalid --port/],
    [['--http', '--port', 'abc'], /Invalid --port/],
    [['--http', '--host', 'a b'], /Invalid --host/],
    [['--token', 'x'], /Unknown option/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});
