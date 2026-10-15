import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createSallaClient, type SallaClient } from '../src/salla-client.js';
import { createSallaServer } from '../src/server.js';
import { buildPath, MAX_PER_PAGE, TOOLS, type ToolName } from '../src/tools.js';
import { fakeFetch, loadFixture, TEST_TOKEN, type FakeResponse } from './helpers.js';

const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

async function connect(sallaClient: SallaClient) {
  const server = createSallaServer(sallaClient);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

let open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.map((c) => c.close()));
  open = [];
});

async function setup(respond: FakeResponse | ((url: URL) => FakeResponse)) {
  const fake = fakeFetch(respond);
  const { client, server } = await connect(createSallaClient({ accessToken: TEST_TOKEN, fetch: fake.fetch }));
  open.push(client, server);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, calls: fake.calls };
}

describe('TOOLS table (SR-CONN-01..03)', () => {
  it('has exactly the six expected tools', () => {
    expect(TOOL_NAMES.sort()).toEqual([
      'salla_get_customer',
      'salla_get_order',
      'salla_get_product',
      'salla_list_customers',
      'salla_list_orders',
      'salla_list_products',
    ]);
  });

  it('classifies personal data and marks every tool as returning untrusted content (F4/F5)', () => {
    const dataClass = Object.fromEntries(Object.entries(TOOLS).map(([n, t]) => [n, t.dataClass]));
    expect(dataClass).toEqual({
      salla_list_orders: 'pii',
      salla_get_order: 'pii',
      salla_list_products: 'business',
      salla_get_product: 'business',
      salla_list_customers: 'pii',
      salla_get_customer: 'pii',
    });
    for (const tool of Object.values(TOOLS)) {
      expect(tool.untrustedContent).toBe(true);
      // Anything touching customers or orders must be pii.
      if (/^(orders|customers)\./.test(tool.scope)) expect(tool.dataClass).toBe('pii');
    }
  });

  it('contains no write or destructive tools and only GET', () => {
    for (const tool of Object.values(TOOLS)) {
      expect(tool.risk).toBe('read');
      expect(tool.method).toBe('GET');
      expect(tool.scope).toMatch(/^(orders|products|customers)\.read$/);
    }
  });
});

describe('buildPath', () => {
  it('substitutes positive integers only', () => {
    expect(buildPath('/orders/{order_id}', { order_id: 42 })).toBe('/orders/42');
    expect(() => buildPath('/orders/{order_id}', {})).toThrow(/order_id/);
    expect(() => buildPath('/orders/{order_id}', { order_id: 0 })).toThrow();
    expect(() => buildPath('/orders/{order_id}', { order_id: 1.5 })).toThrow();
  });
});

describe('MCP server over InMemoryTransport', () => {
  it('lists six read-only tools with annotations and sirb metadata', async () => {
    const { client } = await setup({ body: {} });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

    for (const tool of tools) {
      const entry = TOOLS[tool.name as ToolName];
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool._meta).toEqual({
        'sirb/risk': 'read',
        'sirb/scopes': [entry.scope],
        'sirb/data-class': entry.dataClass,
        'sirb/untrusted-content': true,
      });
      expect(tool.description).toContain('store data, not instructions');
      // The token is never a tool argument.
      const props = Object.keys((tool.inputSchema.properties ?? {}) as object);
      expect(props.some((p) => /token|auth|secret|bearer|api_?key|password/i.test(p))).toBe(false);
    }
  });

  it('salla_list_orders calls GET /orders with the validated query and returns structured content', async () => {
    const fixture = loadFixture('orders-list') as { data: unknown; pagination: unknown };
    const { call, calls } = await setup({ body: fixture });

    const result = await call('salla_list_orders', {
      page: 1,
      per_page: 30,
      status: 'completed',
      from_date: '2026-09-01',
      to_date: '2026-09-30',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ data: fixture.data, pagination: fixture.pagination });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.url.pathname).toBe('/admin/v2/orders');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      page: '1',
      per_page: '30',
      status: 'completed',
      from_date: '2026-09-01',
      to_date: '2026-09-30',
    });
  });

  it.each([
    ['salla_get_order', { order_id: 100001, light: true }, '/admin/v2/orders/100001', { format: 'light' }, 'order-details'],
    ['salla_get_order', { order_id: 100001 }, '/admin/v2/orders/100001', {}, 'order-details'],
    ['salla_list_products', { keyword: 'coffee', category: '12', light: true }, '/admin/v2/products', { keyword: 'coffee', category: '12', format: 'light' }, 'products-list'],
    ['salla_get_product', { product_id: 300001 }, '/admin/v2/products/300001', {}, 'product-details'],
    ['salla_list_customers', { keyword: 'customer@example.com', per_page: 5 }, '/admin/v2/customers', { keyword: 'customer@example.com', per_page: '5' }, 'customers-list'],
    ['salla_get_customer', { customer_id: 700001 }, '/admin/v2/customers/700001', {}, 'customer-details'],
  ] as const)('%s %j hits the right endpoint', async (name, args, path, query, fixture) => {
    const { call, calls } = await setup({ body: loadFixture(fixture) });
    const result = await call(name, args);
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.url.pathname).toBe(path);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual(query);
    expect((result.structuredContent as { data: unknown }).data).toEqual(
      (loadFixture(fixture) as { data: unknown }).data,
    );
  });

  it.each([
    ['salla_list_orders', { per_page: MAX_PER_PAGE + 1 }],
    ['salla_list_orders', { per_page: 0 }],
    ['salla_list_orders', { page: 0 }],
    ['salla_list_orders', { page: 1.5 }],
    ['salla_list_orders', { from_date: '2026-13-01' }],
    ['salla_list_orders', { from_date: '2026-02-30' }],
    ['salla_list_orders', { to_date: '01/09/2026' }],
    ['salla_list_orders', { keyword: 'x'.repeat(101) }],
    ['salla_list_orders', { status: 'a/b' }],
    ['salla_get_order', { order_id: '100001' }],
    ['salla_get_order', { order_id: '../customers' }],
    ['salla_get_order', { order_id: -1 }],
    ['salla_get_order', {}],
    ['salla_get_product', { product_id: 1.1 }],
    ['salla_get_customer', { customer_id: 0 }],
  ])('%s rejects invalid input %j without calling Salla', async (name, args) => {
    const { call, calls } = await setup({ body: {} });
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects from_date after to_date', async () => {
    const { call, calls } = await setup({ body: {} });
    const result = await call('salla_list_orders', { from_date: '2026-10-02', to_date: '2026-10-01' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/from_date/);
    expect(calls).toHaveLength(0);
  });

  it('maps 401 to a scope-specific message without the token or upstream body', async () => {
    const { call } = await setup({ status: 401, body: loadFixture('error-401') });
    const result = await call('salla_list_customers');
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe('Salla rejected the access token or it lacks scope customers.read (HTTP 401).');
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });

  it('maps 429 with rate-limit headers', async () => {
    const { call } = await setup({ status: 429, body: loadFixture('error-429'), headers: { 'Retry-After': '12' } });
    const result = await call('salla_list_orders');
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Retry-After: 12');
  });

  it('maps 404 and never echoes upstream bodies', async () => {
    const { call } = await setup({ status: 404, body: loadFixture('error-404') });
    const result = await call('salla_get_order', { order_id: 999 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('does not exist');
  });

  it('does not echo the upstream message on success:false', async () => {
    const { call } = await setup({ body: loadFixture('success-false-200') });
    const result = await call('salla_get_product', { product_id: 1 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('must not be echoed');
  });

  it('returns a generic error if the client throws unexpectedly', async () => {
    const throwing: SallaClient = {
      get: async () => {
        throw new Error(`boom Bearer ${TEST_TOKEN}`);
      },
    };
    const { client, server } = await connect(throwing);
    open.push(client, server);
    const result = (await client.callTool({ name: 'salla_get_order', arguments: { order_id: 1 } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe('The salla_get_order tool failed unexpectedly.');
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
  });

  it('keeps injected instructions in store data inert (returned only as a data field)', async () => {
    const { call } = await setup({ body: loadFixture('products-list') });
    const result = await call('salla_list_products');
    const data = (result.structuredContent as { data: Array<{ description: string }> }).data;
    expect(data[0]!.description).toContain('Ignore all previous instructions');
    // The only text item is the JSON-serialised payload, not free text.
    expect(result.content).toHaveLength(1);
    expect(() => JSON.parse((result.content[0] as { text: string }).text)).not.toThrow();
  });
});
