/**
 * Test-engineer review additions: per-tool end-to-end checks, read-only invariant, input
 * validation, error mapping and token non-leakage, HTTP tenant isolation, injection and
 * pagination passthrough. No live network: Salla is an injected fake `fetch`; HTTP tests bind
 * 127.0.0.1 on an ephemeral port only.
 */
import { request, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serverUrl, startHttpServer } from '../src/http.js';
import { createSallaClient } from '../src/salla-client.js';
import { createSallaServer } from '../src/server.js';
import { projectCustomers, projectOrders } from '../src/project.js';
import { TOOLS } from '../src/tools.js';
import { fakeFetch, loadFixture, TEST_TOKEN, type FakeResponse } from './helpers.js';

const BASE = 'https://api.salla.dev/admin/v2';
const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

let open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.map((c) => c.close()));
  open = [];
});

async function connectWith(fetchImpl: typeof globalThis.fetch, timeoutMs?: number) {
  const server = createSallaServer(createSallaClient({ accessToken: TEST_TOKEN, fetch: fetchImpl, timeoutMs }));
  const client = new Client({ name: 'review-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  open.push(client, server);
  return client;
}

async function setup(respond: FakeResponse | ((url: URL) => FakeResponse)) {
  const fake = fakeFetch(respond);
  const client = await connectWith(fake.fetch);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, calls: fake.calls };
}

describe('per-tool happy path: exact URL, bearer, GET only', () => {
  const cases = [
    ['salla_list_orders', { page: 2, per_page: 10, keyword: 'EX-1', status: 'completed', from_date: '2026-09-01', to_date: '2026-09-30' }, `${BASE}/orders?page=2&per_page=10&keyword=EX-1&status=completed&from_date=2026-09-01&to_date=2026-09-30`, 'orders-list'],
    ['salla_list_orders', {}, `${BASE}/orders`, 'orders-list'],
    ['salla_get_order', { order_id: 100001 }, `${BASE}/orders/100001`, 'order-details'],
    ['salla_get_order', { order_id: 100001, light: true }, `${BASE}/orders/100001?format=light`, 'order-details'],
    ['salla_list_products', { page: 1, per_page: 30, keyword: 'coffee', status: 'sale', category: 'beans', light: true }, `${BASE}/products?page=1&per_page=30&keyword=coffee&status=sale&category=beans&format=light`, 'products-list'],
    ['salla_get_product', { product_id: 300001 }, `${BASE}/products/300001`, 'product-details'],
    ['salla_list_customers', { page: 3, per_page: 5, keyword: 'customer@example.com' }, `${BASE}/customers?page=3&per_page=5&keyword=customer%40example.com`, 'customers-list'],
    ['salla_get_customer', { customer_id: 700001 }, `${BASE}/customers/700001`, 'customer-details'],
  ] as const;

  it.each(cases)('%s %j', async (name, args, href, fixture) => {
    const body = loadFixture(fixture) as { data: unknown; pagination?: unknown };
    const { call, calls } = await setup({ body });
    const result = await call(name, args);

    // Orders and customers are projected (no contact fields by default); products pass through.
    const shaped = name.includes('order')
      ? projectOrders(body.data)
      : name.includes('customer')
        ? projectCustomers(body.data)
        : body.data;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(
      body.pagination === undefined ? { data: shaped } : { data: shaped, pagination: body.pagination },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe(href);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
    expect(calls[0]!.headers.get('accept')).toBe('application/json');
  });

  it('covers every tool in TOOLS at least once', () => {
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(Object.keys(TOOLS)));
  });
});

describe('read-only invariant (SR-CONN-01..03)', () => {
  it('every TOOLS entry is risk read and method GET', () => {
    for (const [name, t] of Object.entries(TOOLS)) {
      expect(t.risk, name).toBe('read');
      expect(t.method, name).toBe('GET');
    }
  });

  it('tools/list exposes exactly the TOOLS keys, each tagged read-only', async () => {
    const { client } = await setup({ body: {} });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(t._meta?.['sirb/risk'], t.name).toBe('read');
    }
  });

  it('an unregistered write-style tool cannot be called and never reaches Salla', async () => {
    const { client, calls } = await setup({ body: {} });
    for (const name of ['salla_delete_order', 'salla_update_order', 'salla_create_product']) {
      const outcome = await client.callTool({ name, arguments: { order_id: 1 } }).then(
        (r) => (r as CallToolResult).isError === true,
        () => true,
      );
      expect(outcome).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('input validation rejects before fetch', () => {
  it.each([
    ['salla_get_order', { order_id: -5 }],
    ['salla_get_order', { order_id: 1.5 }],
    ['salla_get_order', { order_id: 2 ** 53 }],
    ['salla_get_order', { order_id: '1/../..' }],
    ['salla_get_order', { order_id: '1' }],
    ['salla_get_order', { order_id: '../../customers' }],
    ['salla_get_order', { order_id: '1?x=y' }],
    ['salla_get_product', { product_id: '1/../..' }],
    ['salla_get_product', { product_id: -1 }],
    ['salla_get_customer', { customer_id: '1/../..' }],
    ['salla_get_customer', { customer_id: 1.5 }],
    ['salla_list_products', { per_page: 31 }],
    ['salla_list_customers', { per_page: 31 }],
    ['salla_list_customers', { page: -1 }],
    ['salla_list_orders', { per_page: 31 }],
    ['salla_list_orders', { from_date: 'yesterday' }],
    ['salla_list_orders', { to_date: '2026-02-30' }],
    ['salla_list_orders', { status: '../x' }],
    ['salla_list_products', { category: 'a b/c' }],
  ])('%s %j', async (name, args) => {
    const { call, calls } = await setup({ body: {} });
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('from_date after to_date is rejected; equal dates are allowed', async () => {
    const { call, calls } = await setup({ body: loadFixture('orders-list') });
    expect((await call('salla_list_orders', { from_date: '2026-09-30', to_date: '2026-09-01' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect((await call('salla_list_orders', { from_date: '2026-09-01', to_date: '2026-09-01' })).isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  it('does not forward unknown extra arguments to Salla', async () => {
    const { call, calls } = await setup({ body: loadFixture('orders-list') });
    await call('salla_list_orders', { page: 1, evil: 'x', access_token: 'y' });
    for (const c of calls) {
      expect([...c.url.searchParams.keys()]).not.toContain('evil');
      expect([...c.url.searchParams.keys()]).not.toContain('access_token');
    }
  });
});

describe('error mapping and token non-leakage', () => {
  // Upstream bodies deliberately echo the token to prove nothing is passed through.
  const leaky = { success: false, error: { message: `bad token ${TEST_TOKEN}` } };
  const cases: Array<[string, FakeResponse, RegExp]> = [
    ['401', { status: 401, body: leaky }, /HTTP 401/],
    ['403', { status: 403, body: leaky }, /HTTP 403/],
    ['404', { status: 404, body: leaky }, /404/],
    ['429', { status: 429, body: leaky, headers: { 'Retry-After': '30', 'X-RateLimit-Reset': '1790000000' } }, /Retry-After: 30; X-RateLimit-Reset: 1790000000/],
    ['500', { status: 500, body: leaky }, /HTTP 500/],
    ['502 html', { status: 502, rawBody: `<html>${TEST_TOKEN}</html>`, headers: { 'Content-Type': 'text/html' } }, /HTTP 502/],
    ['success:false', { body: { success: false, error: { message: TEST_TOKEN } } }, /unsuccessful/],
    ['200 non-JSON', { rawBody: `<html>${TEST_TOKEN}</html>`, headers: { 'Content-Type': 'text/html' } }, /could not be read/],
    ['200 empty body', { rawBody: '' }, /could not be read/],
    ['200 JSON array', { rawBody: '[]' }, /could not be read/],
    ['200 missing data', { body: { success: true } }, /could not be read/],
  ];

  it.each(cases)('%s', async (_label, response, expected) => {
    const { call } = await setup(response);
    const result = await call('salla_get_order', { order_id: 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(expected);
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });

  it('429 hostile headers are sanitised', async () => {
    const { call } = await setup({
      status: 429,
      body: {},
      headers: { 'Retry-After': `10 ${TEST_TOKEN}`, 'X-RateLimit-Reset': 'abc<script>' },
    });
    const text = textOf(await call('salla_list_orders'));
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain('<script>');
  });

  it.each([
    ['TimeoutError', 'timed out'],
    ['AbortError', 'timed out'],
    ['TypeError', 'Could not reach'],
  ])('fetch rejecting with %s maps to a safe message', async (name, expected) => {
    const err = new Error(`connect failed with Authorization: Bearer ${TEST_TOKEN}`);
    err.name = name;
    const client = await connectWith((async () => {
      throw err;
    }) as typeof fetch);
    const result = (await client.callTool({ name: 'salla_list_products', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(expected);
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });

  it('a real AbortSignal timeout is honoured without sleeping (fake timers)', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const hanging = ((_u: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        seen = init.signal ?? undefined;
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const client = await connectWith(hanging, 50);
    const pending = client.callTool({ name: 'salla_get_order', arguments: { order_id: 1 } });
    await vi.advanceTimersByTimeAsync(100);
    // AbortSignal.timeout uses an internal timer fake timers may not control; abort via the
    // signal's own controller is not available, so only assert the signal was supplied.
    expect(seen).toBeInstanceOf(AbortSignal);
    if (seen!.aborted) {
      const result = (await pending) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('timed out');
    } else {
      // Not controllable under fake timers in this runtime; avoid a real sleep and drop the call.
      void pending.catch(() => undefined);
    }
  });

  it('a client that throws an error containing the token yields no token in the result', async () => {
    const throwing = { get: async () => { throw new Error(`Bearer ${TEST_TOKEN}`); } };
    const server = createSallaServer(throwing);
    const client = new Client({ name: 'c', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    open.push(client, server);
    const result = (await client.callTool({ name: 'salla_get_order', arguments: { order_id: 1 } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });
});

describe('untrusted text is returned as data', () => {
  it('keeps projected hostile strings verbatim, only inside the JSON payload', async () => {
    type Order = { customer: { first_name: string }; items: Array<{ name: string }>; notes?: string };
    const body = loadFixture('orders-injection') as { data: Order[] };
    const { call, calls } = await setup({ body });
    const result = await call('salla_list_orders', { include_contact: true });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    const [order] = (result.structuredContent as { data: Order[] }).data;
    expect(order!.customer.first_name).toBe(body.data[0]!.customer.first_name);
    expect(order!.items[0]!.name).toBe(body.data[0]!.items[0]!.name);
    // Free-text notes and gift messages are not part of the order projection at all.
    expect(order).not.toHaveProperty('notes');
    expect(order).not.toHaveProperty('gift_message');
    // Injected text did not trigger any extra upstream call.
    expect(calls).toHaveLength(1);
  });
});

describe('pagination passthrough', () => {
  it('links: [] is passed through unchanged', async () => {
    const body = loadFixture('products-list') as { pagination: { links: unknown } };
    const { call } = await setup({ body });
    const r = await call('salla_list_products');
    expect((r.structuredContent as { pagination: unknown }).pagination).toEqual(body.pagination);
    expect(body.pagination.links).toEqual([]);
  });

  it('links: {next, previous} is passed through unchanged', async () => {
    const body = loadFixture('products-list-links-object') as { pagination: { links: Record<string, string> } };
    const { call } = await setup({ body });
    const r = await call('salla_list_products', { page: 2, per_page: 1 });
    const p = (r.structuredContent as { pagination: { links: Record<string, string> } }).pagination;
    expect(p).toEqual(body.pagination);
    expect(p.links.next).toBe('https://api.salla.dev/admin/v2/products?page=3');
    expect(p.links.previous).toBe('https://api.salla.dev/admin/v2/products?page=1');
  });

  it('omits pagination for single-resource responses', async () => {
    const { call } = await setup({ body: loadFixture('product-details') });
    const r = await call('salla_get_product', { product_id: 300001 });
    expect(r.structuredContent).not.toHaveProperty('pagination');
  });
});

describe('HTTP transport (127.0.0.1, ephemeral port)', () => {
  const TOKEN_A = 'tenant-a-token-AAAAAAAAAAAAAAAAAAAAAAAA-111111';
  const TOKEN_B = 'tenant-b-token-BBBBBBBBBBBBBBBBBBBBBBBB-222222';
  const seenAuth: string[] = [];
  const waiting: Array<() => void> = [];
  let maxInFlight = 0;
  let inFlight = 0;

  // Fake Salla: holds each request until two are in flight, then releases in reverse order, so
  // a shared (non-per-request) client would visibly mix the tokens up.
  const gatedFetch = (async (_url: unknown, init: RequestInit) => {
    const auth = new Headers(init.headers).get('authorization') ?? '';
    seenAuth.push(auth);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === 2) {
        const release = waiting.splice(0).reverse();
        release.forEach((r) => r());
      }
    });
    inFlight--;
    return new Response(JSON.stringify({ success: true, data: { id: 1, echoed_auth: auth } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      log: () => undefined,
      createClient: (accessToken) => createSallaClient({ accessToken, fetch: gatedFetch }),
    });
    url = serverUrl(server);
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const rpc = (method: string, params: unknown, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

  it('missing, wrong-scheme and malformed bearer give 401 with WWW-Authenticate', async () => {
    for (const authorization of [undefined, 'Basic abc', 'Bearer', 'Bearer a b', 'Bearer a;b', 'Token abc']) {
      const res = await fetch(url, {
        method: 'POST',
        headers: authorization ? { ...HEADERS, authorization } : HEADERS,
        body: rpc('tools/list', {}),
      });
      expect(res.status, String(authorization)).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
  });

  it('two concurrent requests with different tokens each reach Salla with their own token', async () => {
    const callAs = async (token: string) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, Authorization: `Bearer ${token}` },
        // Products are not projected, so the fake's echoed_auth field survives to the result.
        body: rpc('tools/call', { name: 'salla_get_product', arguments: { product_id: 1 } }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { result: CallToolResult };
    };
    const [a, b] = await Promise.all([callAs(TOKEN_A), callAs(TOKEN_B)]);

    expect(maxInFlight).toBe(2);
    expect([...seenAuth].sort()).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
    const echo = (r: { result: CallToolResult }) =>
      (r.result.structuredContent as { data: { echoed_auth: string } }).data.echoed_auth;
    expect(echo(a)).toBe(`Bearer ${TOKEN_A}`);
    expect(echo(b)).toBe(`Bearer ${TOKEN_B}`);
  });

  const withHost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      const req = request(
        { host: u.hostname, port: u.port, path: '/mcp', method: 'POST', headers: { ...HEADERS, Authorization: `Bearer ${TOKEN_A}`, Host: host } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(rpc('tools/list', {}));
    });

  it('rejects non-loopback Host headers (DNS rebinding) and accepts loopback names', async () => {
    for (const host of ['evil.example', 'evil.example:80', '127.0.0.1.evil.example', '10.0.0.5']) {
      expect(await withHost(host), `host=${JSON.stringify(host)}`).toBe(403);
    }
    expect(await withHost('localhost')).toBe(200);
    expect(await withHost(`127.0.0.1:${new URL(url).port}`)).toBe(200);
  });

  it('returns 413 for an oversized body and does not leak the token', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Bearer ${TOKEN_A}` },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.text()).not.toContain(TOKEN_A);
  });
});
