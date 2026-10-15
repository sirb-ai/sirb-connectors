/**
 * Regression tests for the security review of @sirb/mcp-salla:
 * F1 (malformed request target crashed the process), F2 (JSON-RPC batch fan-out),
 * 2xx-only success, F9 (pinned npx in README) and F11 (stdio token validation).
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { safePathname, serverUrl, startHttpServer, withErrorBoundary } from '../src/http.js';
import { createSallaClient } from '../src/salla-client.js';
import { readStdioToken } from '../src/stdio.js';
import { isValidBearerToken } from '../src/token.js';
import { fakeFetch, loadFixture, TEST_TOKEN } from './helpers.js';

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };
const toolsList = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

const fake = fakeFetch({ body: loadFixture('customers-list') });
const createClient = vi.fn((accessToken: string) => createSallaClient({ accessToken, fetch: fake.fetch }));
const logs: string[] = [];
let server: Server;
let url: string;
let port: number;

beforeAll(async () => {
  server = await startHttpServer({ host: '127.0.0.1', port: 0, createClient, log: (m) => logs.push(m) });
  url = serverUrl(server);
  port = Number(new URL(url).port);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Writes `raw` to a fresh TCP socket and resolves with the HTTP status line. */
function rawRequest(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(raw));
    let data = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('timeout waiting for response'));
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      if (data.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('error', reject);
  });
}

describe('F1: malformed request target', () => {
  it('safePathname returns undefined instead of throwing', () => {
    expect(safePathname('http://[')).toBeUndefined();
    expect(safePathname('/mcp?x=1')).toBe('/mcp');
    expect(safePathname(undefined)).toBe('/');
  });

  it('answers `POST http://[` with 400 over a real socket and keeps serving', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const reply = await rawRequest(
        'POST http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      expect(reply.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
      expect(reply).toContain('"code":-32600');

      const next = await fetch(url, { method: 'POST', headers: { ...MCP_HEADERS, ...AUTH }, body: JSON.stringify(toolsList(1)) });
      expect(next.status).toBe(200);
      expect(((await next.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(6);
      // Give any stray rejection a turn to surface.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('F1: top-level error boundary', () => {
  const fakeRes = (headersSent = false) => {
    const res = {
      headersSent,
      writableEnded: false,
      writeHead: vi.fn(),
      end: vi.fn(() => {
        res.writableEnded = true;
      }),
    };
    return res;
  };
  const req = { headers: { authorization: `Bearer ${TEST_TOKEN}` } } as unknown as IncomingMessage;

  it('logs redacted, replies 500 and ends the response when the handler rejects', async () => {
    const log = vi.fn();
    const res = fakeRes();
    withErrorBoundary(async () => {
      throw new Error(`exploded with ${TEST_TOKEN}`);
    }, log)(req, res as unknown as ServerResponse);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());

    expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('[REDACTED]');
    expect(log.mock.calls[0]![0]).not.toContain(TEST_TOKEN);
  });

  it('only ends the response if headers were already sent, and catches synchronous throws', async () => {
    const res = fakeRes(true);
    withErrorBoundary((() => {
      throw new Error('sync');
    }) as never, vi.fn())(req, res as unknown as ServerResponse);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalledTimes(1));
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});

describe('F2: JSON-RPC batches are rejected', () => {
  it('returns 400 for an array body without calling Salla', async () => {
    createClient.mockClear();
    fake.calls.length = 0;
    const batch = Array.from({ length: 100 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'tools/call',
      params: { name: 'salla_list_customers', arguments: {} },
    }));
    const res = await fetch(url, { method: 'POST', headers: { ...MCP_HEADERS, ...AUTH }, body: JSON.stringify(batch) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number; message: string } }).error).toMatchObject({
      code: -32600,
      message: expect.stringMatching(/batch/i),
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('also rejects a batch of one', async () => {
    const res = await fetch(url, { method: 'POST', headers: { ...MCP_HEADERS, ...AUTH }, body: JSON.stringify([toolsList(1)]) });
    expect(res.status).toBe(400);
  });
});

describe('only 2xx is success', () => {
  it.each([301, 302, 304, 307, 399])('maps HTTP %i to a non-ok error', async (status) => {
    const nullBody = status === 304;
    const fetch = (async () =>
      new Response(nullBody ? null : JSON.stringify(loadFixture('customers-list')), { status })) as typeof globalThis.fetch;
    const result = await createSallaClient({ accessToken: TEST_TOKEN, fetch }).get('/customers');
    expect(result).toEqual({ ok: false, error: { kind: 'http', status } });
  });

  it('does not trust a non-standard fetch that reports ok for a 3xx', async () => {
    const fetch = (async () => ({
      ok: true,
      status: 302,
      headers: new Headers(),
      body: null,
      json: async () => loadFixture('customers-list'),
    })) as unknown as typeof globalThis.fetch;
    const result = await createSallaClient({ accessToken: TEST_TOKEN, fetch }).get('/customers');
    expect(result).toEqual({ ok: false, error: { kind: 'http', status: 302 } });
  });
});

describe('F11: stdio token validation', () => {
  it.each([
    ['contains whitespace', 'abc def-secret-value'],
    ['contains a newline', 'abcdef\nInjected: header'],
    ['contains quotes', '"secret-value-123"'],
    ['is too long', 'a'.repeat(4097)],
  ])('rejects a token that %s without echoing it', (_label, value) => {
    let message = '';
    try {
      readStdioToken({ SALLA_ACCESS_TOKEN: value });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a valid OAuth bearer token/);
    expect(message).not.toContain(value.trim());
    expect(message).not.toContain('secret');
  });

  it('accepts RFC 6750 b64token characters', () => {
    expect(readStdioToken({ SALLA_ACCESS_TOKEN: 'ab.CD-12_~+/x==' })).toBe('ab.CD-12_~+/x==');
    expect(isValidBearerToken('a'.repeat(4096))).toBe(true);
    expect(isValidBearerToken('')).toBe(false);
  });
});

describe('F9: README pins the published version', () => {
  it('uses `npx -y @sirb/mcp-salla@<package.json version>` and no unpinned npx', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(readme).toContain(`"@sirb/mcp-salla@${version}"`);
    expect(readme).not.toMatch(/"@sirb\/mcp-salla"(?!@)/);
  });
});
