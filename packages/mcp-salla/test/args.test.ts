import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/args.js';

describe('parseCliArgs', () => {
  it('defaults to stdio', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'stdio', revealContactDetails: false });
    expect(parseCliArgs(['--stdio'])).toEqual({ mode: 'stdio', revealContactDetails: false });
  });

  it('parses http with loopback defaults', () => {
    expect(parseCliArgs(['--http'])).toEqual({
      mode: 'http',
      host: '127.0.0.1',
      port: 3000,
      allowRemote: false,
      allowedHosts: [],
      revealContactDetails: false,
    });
    expect(parseCliArgs(['--http', '--port', '8080', '--host', '::1'])).toEqual({
      mode: 'http',
      host: '::1',
      port: 8080,
      allowRemote: false,
      allowedHosts: [],
      revealContactDetails: false,
    });
  });

  it('parses --reveal-contact-details in both modes (default: masked)', () => {
    expect(parseCliArgs(['--reveal-contact-details'])).toEqual({ mode: 'stdio', revealContactDetails: true });
    expect(parseCliArgs(['--http', '--reveal-contact-details'])).toMatchObject({ mode: 'http', revealContactDetails: true });
  });

  it('requires --allow-remote and --allowed-host for a non-loopback bind', () => {
    expect(() => parseCliArgs(['--http', '--host', '0.0.0.0'])).toThrow(/--allow-remote/);
    expect(() => parseCliArgs(['--http', '--host', '0.0.0.0', '--allow-remote'])).toThrow(/--allowed-host/);
    expect(
      parseCliArgs(['--http', '--host', '0.0.0.0', '--allow-remote', '--allowed-host', 'MCP.internal', '--allowed-host', 'b']),
    ).toEqual({
      mode: 'http',
      host: '0.0.0.0',
      port: 3000,
      allowRemote: true,
      allowedHosts: ['mcp.internal', 'b'],
      revealContactDetails: false,
    });
  });

  it('parses help', () => {
    expect(parseCliArgs(['-h'])).toEqual({ mode: 'help' });
  });

  it.each([
    [['--http', '--stdio'], /either/],
    [['--port', '1'], /only valid with --http/],
    [['--allow-remote'], /only valid with --http/],
    [['--http', '--allowed-host', 'a b'], /Invalid --allowed-host/],
    [['--http', '--port', '70000'], /Invalid --port/],
    [['--http', '--port', 'abc'], /Invalid --port/],
    [['--http', '--host', 'a b'], /Invalid --host/],
    [['--token', 'x'], /Unknown option/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});
