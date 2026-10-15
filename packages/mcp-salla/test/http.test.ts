import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isLoopbackHost, parseBearer, serverUrl, startHttpServer } from '../src/http.js';
import { createSallaClient } from '../src/salla-client.js';
import { fakeFetch, loadFixture, TEST_TOKEN } from './helpers.js';

const OTHER_TOKEN = 'other-tenant-token-ZYXWVUTSRQPONMLKJIHGFEDCBA-987654321';

const fake = fakeFetch({ body: loadFixture('order-details') });
const createClient = vi.fn((accessToken: string) => createSallaClient({ accessToken, fetch: fake.fetch }));
const logs: string[] = [];

let server: Server;
let url: string;

beforeAll(async () => {
  server = await startHttpServer({ port: 0, createClient, log: (m) => logs.push(m) });
  url = serverUrl(server);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const listTools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

describe('HTTP handler', () => {
  it('binds to 127.0.0.1 by default-style options', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('returns 401 JSON-RPC with WWW-Authenticate when the bearer is missing', async () => {
    const res = await fetch(url, { method: 'POST', headers: MCP_HEADERS, body: listTools });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32001);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer a b', `Bearer ${'x'.repeat(5000)}`])(
    'returns 401 for a malformed authorization header (%#)',
    async (authorization) => {
      const res = await fetch(url, { method: 'POST', headers: { ...MCP_HEADERS, authorization }, body: listTools });
      expect(res.status).toBe(401);
    },
  );

  it('returns 404 for other paths, 405 for GET, 400 for bad JSON and 403 for foreign Host', async () => {
    const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
    expect((await fetch(url.replace('/mcp', '/other'), { headers: auth })).status).toBe(404);

    const get = await fetch(url, { headers: { ...auth, Accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const bad = await fetch(url, { method: 'POST', headers: { ...MCP_HEADERS, ...auth }, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);

    // DNS-rebinding protection: undici lets us override Host.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      const req = request(
        { host: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers: { ...MCP_HEADERS, ...auth, Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(listTools);
    });
    expect(status).toBe(403);
  });

  it('returns 413 for oversized bodies (Content-Length and chunked) and keeps serving', async () => {
    const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
    const big = 'x'.repeat(1024 * 1024 + 1);

    for (let i = 0; i < 3; i++) {
      const res = await fetch(url, { method: 'POST', headers: { ...MCP_HEADERS, ...auth }, body: big });
      expect(res.status).toBe(413);
      expect(res.headers.get('connection')).toBe('close');
    }

    // Chunked upload with no Content-Length exercises the streaming limit.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      const req = request(
        { host: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers: { ...MCP_HEADERS, ...auth } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(big.slice(0, 600_000));
      req.end(big.slice(600_000));
    });
    expect(status).toBe(413);

    // The server is still healthy afterwards.
    const after = await fetch(url, { method: 'POST', headers: { ...MCP_HEADERS, ...auth }, body: listTools });
    expect(after.status).toBe(200);
  }, 15_000);

  it('serves MCP end to end with a per-request client bound to each caller token', async () => {
    createClient.mockClear();
    fake.calls.length = 0;

    const callAs = async (token: string) => {
      const client = new Client({ name: 'http-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      const result = (await client.callTool({
        name: 'salla_get_order',
        arguments: { order_id: 100001 },
      })) as CallToolResult;
      await client.close();
      return { tools, result };
    };

    const a = await callAs(TEST_TOKEN);
    expect(a.tools).toHaveLength(6);
    expect(a.result.isError).toBeFalsy();
    expect((a.result.structuredContent as { data: { id: number } }).data.id).toBe(100001);

    await callAs(OTHER_TOKEN);

    const tokensSeen = new Set(createClient.mock.calls.map(([t]) => t));
    expect(tokensSeen).toEqual(new Set([TEST_TOKEN, OTHER_TOKEN]));
    const upstreamAuth = fake.calls.map((c) => c.headers.get('authorization'));
    expect(upstreamAuth).toEqual([`Bearer ${TEST_TOKEN}`, `Bearer ${OTHER_TOKEN}`]);
    expect(logs.join('\n')).not.toContain(TEST_TOKEN);
  });
});

describe('helpers', () => {
  it('parseBearer accepts RFC 6750 tokens only', () => {
    expect(parseBearer('Bearer abc.DEF-123_~+/==')).toBe('abc.DEF-123_~+/==');
    expect(parseBearer(undefined)).toBeUndefined();
    expect(parseBearer(['Bearer a'])).toBeUndefined();
    expect(parseBearer('bearer')).toBeUndefined();
  });

  it('isLoopbackHost', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});

describe('HTTP hardening', () => {
  const raw = (target: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(target);
      void import('node:http').then(({ request }) => {
        const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(listTools);
      });
    });
  const auth = { Authorization: `Bearer ${TEST_TOKEN}` };

  it('accepts the bearer scheme case-insensitively (RFC 7235)', () => {
    expect(parseBearer('bearer abc')).toBe('abc');
    expect(parseBearer('BEARER abc')).toBe('abc');
  });

  it('rejects a foreign or null Origin and accepts a loopback one', async () => {
    expect(await raw(url, { ...MCP_HEADERS, ...auth, Origin: 'https://evil.example' })).toBe(403);
    expect(await raw(url, { ...MCP_HEADERS, ...auth, Origin: 'null' })).toBe(403);
    expect(await raw(url, { ...MCP_HEADERS, ...auth, Origin: 'file://x' })).toBe(403);
    expect(await raw(url, { ...MCP_HEADERS, ...auth, Origin: 'http://localhost:5173' })).toBe(200);
    // No Origin (non-browser MCP clients) is fine.
    expect(await raw(url, { ...MCP_HEADERS, ...auth })).toBe(200);
  });

  it('refuses a non-loopback bind without allowRemote and allowedHostnames', async () => {
    await expect(startHttpServer({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/allowRemote/);
    await expect(startHttpServer({ host: '0.0.0.0', port: 0, allowRemote: true })).rejects.toThrow(/allowedHostnames/);
  });

  it('a remote bind enforces its explicit Host and Origin allowlist', async () => {
    const remote = await startHttpServer({
      host: '0.0.0.0',
      port: 0,
      allowRemote: true,
      allowedHostnames: ['mcp.internal'],
      createClient,
      log: () => undefined,
    });
    try {
      const port = (remote.address() as { port: number }).port;
      const target = `http://127.0.0.1:${port}/mcp`;
      expect(await raw(target, { ...MCP_HEADERS, ...auth, Host: 'evil.example' })).toBe(403);
      expect(await raw(target, { ...MCP_HEADERS, ...auth, Host: `127.0.0.1:${port}` })).toBe(403);
      expect(await raw(target, { ...MCP_HEADERS, ...auth, Host: 'mcp.internal' })).toBe(200);
      expect(await raw(target, { ...MCP_HEADERS, ...auth, Host: 'mcp.internal', Origin: 'https://evil.example' })).toBe(403);
      expect(await raw(target, { ...MCP_HEADERS, ...auth, Host: 'mcp.internal', Origin: 'https://mcp.internal' })).toBe(200);
    } finally {
      await new Promise((resolve) => remote.close(resolve));
    }
  });
});
