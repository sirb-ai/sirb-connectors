/**
 * Output shaping: PII projection, control-character stripping and the result-size cap, both as
 * units and through the MCP tools. No live network.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capPayload,
  isAlwaysDropped,
  maskEmail,
  maskPhone,
  MAX_RESULT_BYTES,
  project,
  projectCustomers,
  projectOrders,
  scrub,
  stripControlChars,
} from '../src/project.js';
import { createSallaClient } from '../src/salla-client.js';
import { createSallaServer } from '../src/server.js';
import { inputSchemas, TOOLS, type SallaToolOptions } from '../src/tools.js';
import { fakeFetch, loadFixture, TEST_TOKEN, type FakeResponse } from './helpers.js';

let open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.map((c) => c.close()));
  open = [];
});

async function setup(respond: FakeResponse | ((url: URL) => FakeResponse), options: SallaToolOptions = {}) {
  const fake = fakeFetch(respond);
  const server = createSallaServer(createSallaClient({ accessToken: TEST_TOKEN, fetch: fake.fetch }), options);
  const client = new Client({ name: 'project-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  open.push(client, server);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, calls: fake.calls };
}

/** Values that must never reach the model, whatever the arguments. */
const NEVER = [
  '1234567890', // bank account number
  'SA0000000000000000000000', // IBAN
  '198.51.100.7', // buyer IP
  'Mozilla/5.0 (Test)', // user agent
  '1990-01-01', // birthday
  '1 Example Street', // street address
  'receipts/100003.png', // receipt image
  'Leave at the door', // order notes
  'avatars/700001.png',
];
const NEVER_KEYS = ['bank', 'source_details', 'birthday', 'gender', 'location', 'receipt_image', 'notes', 'avatar'];

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string' && value.startsWith('{')) {
    // MCP text content carries the same payload as serialized JSON.
    try {
      keysOf(JSON.parse(value), out);
    } catch {
      /* not JSON */
    }
  } else if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

function expectNoSensitive(value: unknown): void {
  const json = JSON.stringify(value);
  for (const s of NEVER) expect(json).not.toContain(s);
  const keys = keysOf(value);
  for (const k of NEVER_KEYS) expect(keys.has(k), k).toBe(false);
}

describe('project()', () => {
  it('keeps only allowlisted fields, recursing into objects and arrays', () => {
    expect(
      project({ a: 1, b: { c: 2, d: 3 }, e: [{ f: 1, g: 2 }], h: 'drop' }, { a: true, b: { c: true }, e: [{ f: true }] }),
    ).toEqual({ a: 1, b: { c: 2 }, e: [{ f: 1 }] });
  });

  it('drops fields whose shape does not match the spec', () => {
    expect(project({ b: 'not an object', e: 'not an array' }, { b: { c: true }, e: [true] })).toEqual({});
    expect(project('scalar', { a: true })).toBeUndefined();
  });

  it('ignores inherited properties', () => {
    const value = Object.create({ inherited: 'x' }) as Record<string, unknown>;
    expect(project(value, { inherited: true })).toEqual({});
  });
});

describe('order and customer projections', () => {
  const order = (loadFixture('order-details-sensitive') as { data: unknown }).data;
  const customer = (loadFixture('customer-details-sensitive') as { data: unknown }).data;

  it('orders: drop bank, IP, user agent, birthday, gender, location, receipt and notes; contact masked by default', () => {
    const shaped = projectOrders(order) as Record<string, unknown>;
    expectNoSensitive(shaped);
    expect(shaped.customer).toEqual({
      id: 700001,
      first_name: 'Test',
      last_name: 'Customer',
      email: 'c***@example.com',
      mobile: '***00',
      mobile_code: '+966',
    });
    expect(shaped).toMatchObject({
      id: 100003,
      reference_id: 50003,
      status: { name: 'بإنتظار المراجعة', slug: 'under_review' },
      payment_method: 'bank',
      amounts: { total: { amount: 245.5, currency: 'SAR' }, tax: { amount: { amount: 20.5, currency: 'SAR' } } },
      items: [{ id: 1, name: 'Example Coffee Beans 250g', sku: 'EX-COF-250', quantity: 2 }],
    });
  });

  it('orders: the operator setting revealContactDetails unmasks email and mobile only', () => {
    const shaped = projectOrders(order, { revealContactDetails: true }) as { customer: unknown };
    expectNoSensitive(shaped);
    expect(shaped.customer).toEqual({
      id: 700001,
      first_name: 'Test',
      last_name: 'Customer',
      email: 'customer@example.com',
      mobile: 500000000,
      mobile_code: '+966',
    });
  });

  const maskedCustomer = {
    id: 700001,
    city: 'Riyadh',
    country: 'Saudi Arabia',
    first_name: 'Test',
    last_name: 'Customer',
    email: 'c***@example.com',
    mobile: '***00',
    mobile_code: '+966',
  };

  it('customers: allowlisted fields with email and mobile masked by default; revealed only by the operator setting', () => {
    expect(projectCustomers(customer)).toEqual(maskedCustomer);
    const revealed = projectCustomers(customer, { revealContactDetails: true });
    expectNoSensitive(revealed);
    expect(revealed).toMatchObject({ email: 'customer@example.com', mobile: 500000000 });
  });

  it('projects each element of a list', () => {
    expect(projectCustomers([customer, customer])).toEqual([maskedCustomer, maskedCustomer]);
  });

  it('contact fields that are not strings or numbers are dropped, not leaked', () => {
    expect(projectCustomers({ id: 1, email: { nested: 'x@y.z' }, mobile: ['500000123'] })).toEqual({ id: 1 });
  });
});

describe('always-dropped keys (IBAN, bank details, buyer IP, user agent)', () => {
  it.each(['iban', 'IBAN', 'bank', 'bank_account', 'bank_transfer_fee', 'account_number', 'accountNumber', 'swift_code', 'ip', 'client_ip', 'ip_address', 'ipAddress', 'user_agent', 'userAgent'])(
    'drops key %s',
    (key) => {
      expect(isAlwaysDropped(key)).toBe(true);
      expect(scrub({ [key]: 'x', keep: 1 })).toEqual({ keep: 1 });
    },
  );

  it.each(['zip', 'shipping', 'description', 'ship', 'tip', 'id', 'currency'])('keeps ordinary key %s', (key) => {
    expect(isAlwaysDropped(key)).toBe(false);
  });

  it('removes them at any depth, including inside allowlisted pass-through fields', () => {
    const order = {
      id: 1,
      amounts: {
        discounts: [{ title: 'Promo', amount: 5, bank_offer: { iban: 'SA9999999999999999999999' } }],
        total: { amount: 10, currency: 'SAR' },
      },
      customer: { id: 2, ip: '203.0.113.9', userAgent: 'UA/1.0', email: 'a@b.co' },
    };
    for (const options of [{}, { revealContactDetails: true }]) {
      const json = JSON.stringify(projectOrders(order, options));
      expect(json).not.toMatch(/SA9999|203\.0\.113\.9|UA\/1\.0|bank_offer|iban|userAgent/);
      expect(json).toContain('Promo');
    }
  });

  it('scrub leaves scalars and arrays of scalars untouched', () => {
    expect(scrub([1, 'a', null, { ip_address: 'x', ok: [{ iban: 'y', z: 1 }] }])).toEqual([1, 'a', null, { ok: [{ z: 1 }] }]);
  });
});

describe('masking', () => {
  it.each([
    ['customer@example.com', 'c***@example.com'],
    ['a@b', 'a***@b'],
    ['@example.com', '***'],
    ['no-at-sign', '***'],
    ['x@y@z.example', 'x***@z.example'],
  ])('maskEmail(%s) = %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  it.each([
    [500000123, '***23'],
    ['+966 50 000 0123', '***23'],
    ['12', '***'],
    ['', '***'],
  ] as const)('maskPhone(%s) = %s', (input, expected) => {
    expect(maskPhone(input)).toBe(expected);
  });
});

describe('PII never reaches the model through the tools', () => {
  it.each([
    ['salla_get_order', { order_id: 100003 }, 'order-details-sensitive', false],
    ['salla_get_order', { order_id: 100003 }, 'order-details-sensitive', true],
    ['salla_get_customer', { customer_id: 700001 }, 'customer-details-sensitive', false],
    ['salla_get_customer', { customer_id: 700001 }, 'customer-details-sensitive', true],
  ] as const)('%s %j revealContactDetails=%s', async (name, args, fixture, reveal) => {
    const { call } = await setup({ body: loadFixture(fixture) }, { revealContactDetails: reveal });
    const result = await call(name, args);
    expect(result.isError).toBeFalsy();
    expectNoSensitive(result);
    const json = JSON.stringify(result.structuredContent);
    expect(json.includes('customer@example.com')).toBe(reveal);
    expect(json.includes('c***@example.com')).toBe(!reveal);
  });

  it('no tool argument can unmask contact details; an unknown include_contact is ignored', async () => {
    for (const schema of Object.values(inputSchemas)) {
      expect(Object.keys(schema).some((k) => /contact|reveal|unmask|pii/i.test(k))).toBe(false);
    }
    const { call } = await setup({ body: loadFixture('customer-details-sensitive') });
    const result = await call('salla_get_customer', { customer_id: 700001, include_contact: true });
    expect(JSON.stringify(result)).not.toContain('customer@example.com');
  });

  it('pii tool descriptions say what is never returned and that contact details are masked', async () => {
    const { client } = await setup({ body: {} });
    const { tools } = await client.listTools();
    for (const t of tools) {
      const pii = TOOLS[t.name as keyof typeof TOOLS].dataClass === 'pii';
      expect(/IBAN.*never returned.*masked/.test(t.description ?? ''), t.name).toBe(pii);
    }
  });

  it('list tools apply the same projection to every record', async () => {
    const order = (loadFixture('order-details-sensitive') as { data: unknown }).data;
    const { call } = await setup({ body: { success: true, data: [order, order] } });
    const result = await call('salla_list_orders');
    expectNoSensitive(result);
    expect((result.structuredContent as { data: unknown[] }).data).toHaveLength(2);
  });
});

describe('stripControlChars()', () => {
  it('removes C0 controls and bidi overrides but keeps tabs, newlines and Arabic text', () => {
    expect(stripControlChars('a\u0000b\u0007c‮d⁦e‏f\tg\nh\ri تجاهل')).toBe('abcdef\tg\nh\ri تجاهل');
  });

  it('recurses into arrays and object keys and values, leaving other types alone', () => {
    expect(stripControlChars({ 'k‮': ['v\u0000', 1, null, true] })).toEqual({ k: ['v', 1, null, true] });
  });

  it('is applied to tool output', async () => {
    const { call } = await setup({ body: loadFixture('orders-injection') });
    const result = await call('salla_list_orders');
    expect(JSON.stringify(result)).not.toMatch(/\\u0000|‮|‬/);
  });
});

describe('capPayload()', () => {
  it('returns small payloads unchanged', () => {
    const payload = { data: [1, 2, 3] };
    expect(capPayload(payload)).toEqual({ ok: true, payload, json: JSON.stringify(payload) });
  });

  it('cuts a list to the longest prefix that fits and says so', () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
    const result = capPayload({ data, pagination: { total: 50 } }, 2_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.byteLength(result.json)).toBeLessThanOrEqual(2_000);
    const items = result.payload.data as unknown[];
    expect(items.length).toBeGreaterThan(0);
    expect(items).toEqual(data.slice(0, items.length));
    expect(result.payload).toMatchObject({ truncated: true, returned_items: items.length, pagination: { total: 50 } });
    expect(result.payload.hint).toMatch(/smaller per_page/);
    // One more item would not have fitted.
    const oneMore = { ...result.payload, data: data.slice(0, items.length + 1) };
    expect(Buffer.byteLength(JSON.stringify(oneMore))).toBeGreaterThan(2_000);
  });

  it('refuses a single object or a list whose first item alone is too big', () => {
    expect(capPayload({ data: { pad: 'x'.repeat(500) } }, 100)).toEqual({ ok: false });
    expect(capPayload({ data: [{ pad: 'x'.repeat(500) }] }, 100)).toEqual({ ok: false });
  });

  it('measures bytes, not UTF-16 code units', () => {
    const arabic = 'ق'.repeat(60); // 120 bytes in UTF-8
    expect(capPayload({ data: arabic }, 100)).toEqual({ ok: false });
  });
});

describe('result size cap through the tools', () => {
  const bigProduct = (id: number) => ({ id, name: `P${id}`, description: 'x'.repeat(10_000) });

  it('a large list comes back truncated, under the cap, with text equal to structuredContent', async () => {
    const data = Array.from({ length: 30 }, (_, i) => bigProduct(i + 1));
    const { call } = await setup({ body: { success: true, data } });
    const result = await call('salla_list_products', { light: false });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ truncated: true });
  });

  it('a single oversized record is an error, not a giant result', async () => {
    const { call } = await setup({ body: { success: true, data: { id: 1, description: 'x'.repeat(MAX_RESULT_BYTES) } } });
    const result = await call('salla_get_product', { product_id: 1 });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/too large/);
  });
});

describe('request shaping', () => {
  it('salla_list_products defaults to format=light; light: false asks for full objects', async () => {
    const { call, calls } = await setup({ body: loadFixture('products-list') });
    await call('salla_list_products');
    await call('salla_list_products', { light: false });
    expect(calls[0]!.url.searchParams.get('format')).toBe('light');
    expect(calls[1]!.url.searchParams.has('format')).toBe(false);
  });

  it('salla_list_customers forwards date_from/date_to and checks their order', async () => {
    const { call, calls } = await setup({ body: loadFixture('customers-list') });
    const ok = await call('salla_list_customers', { date_from: '2026-09-01', date_to: '2026-09-30' });
    expect(ok.isError).toBeFalsy();
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ date_from: '2026-09-01', date_to: '2026-09-30' });

    const bad = await call('salla_list_customers', { date_from: '2026-10-01', date_to: '2026-09-30' });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toBe('date_from must be on or before date_to.');
    expect(calls).toHaveLength(1);
  });

  it('a 422 names only rejected fields that are this tool’s own arguments', async () => {
    const { call } = await setup({
      status: 422,
      body: {
        success: false,
        error: {
          code: 'error',
          message: 'leaky upstream message',
          fields: { status: ['bad'], format: ['bad'], 'x"; DROP': ['bad'], secret_internal: ['bad'] },
        },
      },
    });
    const result = await call('salla_list_products', { status: 'nope' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe('Salla rejected the request (HTTP 422). Invalid fields: status, light.');
    expect(text).not.toContain('leaky');
  });

  it('a 422 with no usable field names gets a generic message', async () => {
    const { call } = await setup({ status: 422, body: { success: false, error: { message: 'x' } } });
    const result = await call('salla_get_product', { product_id: 1 });
    expect((result.content[0] as { text: string }).text).toBe('Salla rejected the request as invalid (HTTP 422).');
  });
});
