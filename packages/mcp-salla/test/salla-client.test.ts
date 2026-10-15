import { describe, expect, it } from 'vitest';
import {
  assertSafeBaseUrl,
  buildUrl,
  createSallaClient,
  describeSallaError,
  SALLA_BASE_URL,
  type SallaResult,
} from '../src/salla-client.js';
import { fakeFetch, loadFixture, TEST_TOKEN } from './helpers.js';

const client = (respond: Parameters<typeof fakeFetch>[0]) => {
  const fake = fakeFetch(respond);
  return { ...fake, client: createSallaClient({ accessToken: TEST_TOKEN, fetch: fake.fetch }) };
};

const assertNoToken = (value: unknown) => {
  expect(JSON.stringify(value)).not.toContain(TEST_TOKEN);
};

describe('createSallaClient', () => {
  it('sends a GET to the pinned Salla host with bearer and Accept headers', async () => {
    const { client: c, calls } = client({ body: loadFixture('orders-list') });
    await c.get('/orders', { page: 2, per_page: 30, keyword: undefined, status: 'completed' });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.init.method).toBe('GET');
    expect(call.url.origin).toBe('https://api.salla.dev');
    expect(call.url.pathname).toBe('/admin/v2/orders');
    expect([...call.url.searchParams]).toEqual([
      ['page', '2'],
      ['per_page', '30'],
      ['status', 'completed'],
    ]);
    expect(call.headers.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
    expect(call.headers.get('accept')).toBe('application/json');
    expect(call.init.redirect).toBe('error');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns data and passes pagination through untouched', async () => {
    const fixture = loadFixture('orders-list') as { data: unknown; pagination: unknown };
    const { client: c } = client({ body: fixture });
    const result = await c.get('/orders');
    expect(result).toEqual({ ok: true, data: fixture.data, pagination: fixture.pagination });
  });

  it('omits pagination when Salla does not send it', async () => {
    const { client: c } = client({ body: loadFixture('order-details') });
    const result = await c.get('/orders/100001');
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('pagination');
  });

  it('accepts pagination with an empty links array', async () => {
    const { client: c } = client({ body: loadFixture('products-list') });
    const result = await c.get('/products');
    expect(result.ok && (result.pagination as { links: unknown }).links).toEqual([]);
  });

  it('rejects an empty token', () => {
    expect(() => createSallaClient({ accessToken: '  ' })).toThrow(/access token is required/);
  });

  it('rejects unsafe paths before any request is made', async () => {
    const { client: c, calls } = client({ body: {} });
    await expect(c.get('/orders/../customers')).rejects.toThrow(/Unsafe/);
    await expect(c.get('https://evil.example/x')).rejects.toThrow(/Unsafe/);
    await expect(c.get('/orders/0')).rejects.toThrow(/Unsafe/);
    expect(calls).toHaveLength(0);
  });
});

describe('error mapping', () => {
  const cases: Array<[string, Parameters<typeof fakeFetch>[0], Partial<Extract<SallaResult, { ok: false }>['error']>]> = [
    ['401', { status: 401, body: loadFixture('error-401') }, { kind: 'unauthorized', status: 401 }],
    ['403', { status: 403, body: {} }, { kind: 'unauthorized', status: 403 }],
    ['404', { status: 404, body: loadFixture('error-404') }, { kind: 'not_found', status: 404 }],
    [
      '429 with headers',
      {
        status: 429,
        body: loadFixture('error-429'),
        headers: { 'Retry-After': '30', 'X-RateLimit-Reset': '1760000000', 'X-RateLimit-Remaining': '0' },
      },
      { kind: 'rate_limited', status: 429, retryAfter: '30', rateLimitReset: '1760000000' },
    ],
    ['500', { status: 500, rawBody: '<html>stack trace</html>' }, { kind: 'http', status: 500 }],
    ['200 success:false', { body: loadFixture('success-false-200') }, { kind: 'unsuccessful', status: 200 }],
    ['non-JSON 200', { rawBody: 'not json' }, { kind: 'invalid_response' }],
    ['JSON without envelope', { body: { hello: 'world' } }, { kind: 'invalid_response' }],
    ['success:true without data', { body: { success: true } }, { kind: 'invalid_response' }],
  ];

  it.each(cases)('maps %s', async (_label, response, expected) => {
    const { client: c } = client(response);
    const result = await c.get('/orders');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject(expected);
    assertNoToken(result);
  });

  it('drops a garbage Retry-After header and keeps a valid HTTP date', async () => {
    const garbage = await client({ status: 429, headers: { 'Retry-After': 'soon<script>' } }).client.get('/orders');
    expect(!garbage.ok && garbage.error.retryAfter).toBeUndefined();

    const dated = await client({
      status: 429,
      headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    }).client.get('/orders');
    expect(!dated.ok && dated.error.retryAfter).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });

  it('maps network failures and timeouts without leaking details', async () => {
    const throwing = (err: Error) =>
      createSallaClient({
        accessToken: TEST_TOKEN,
        fetch: (async () => {
          throw err;
        }) as typeof fetch,
      });

    const net = await throwing(new TypeError(`connect failed Bearer ${TEST_TOKEN}`)).get('/orders');
    expect(net).toEqual({ ok: false, error: { kind: 'network' } });

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(await throwing(timeout).get('/orders')).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
});

describe('describeSallaError', () => {
  it('names the missing scope on 401', () => {
    expect(describeSallaError({ kind: 'unauthorized', status: 401 }, 'orders.read')).toBe(
      'Salla rejected the access token or it lacks scope orders.read (HTTP 401).',
    );
  });

  it('includes rate-limit hints when present', () => {
    const msg = describeSallaError({ kind: 'rate_limited', status: 429, retryAfter: '30', rateLimitReset: '17' }, 's');
    expect(msg).toContain('Retry-After: 30');
    expect(msg).toContain('X-RateLimit-Reset: 17');
    expect(describeSallaError({ kind: 'rate_limited', status: 429 }, 's')).toBe(
      'Salla rate limit reached (HTTP 429). Wait before retrying.',
    );
  });

  it.each([
    ['not_found', /not found/],
    ['unsuccessful', /unsuccessful/],
    ['timeout', /timed out/],
    ['network', /Could not reach/],
    ['invalid_response', /could not be read/],
    ['http', /HTTP 502/],
  ] as const)('describes %s', (kind, pattern) => {
    expect(describeSallaError({ kind, status: 502 }, 'x')).toMatch(pattern);
  });
});

describe('base URL handling', () => {
  it('defaults to the Salla admin v2 API', () => {
    expect(SALLA_BASE_URL).toBe('https://api.salla.dev/admin/v2');
  });

  it('allows https and loopback http only', () => {
    expect(assertSafeBaseUrl('https://sandbox.example/admin/v2').protocol).toBe('https:');
    expect(assertSafeBaseUrl('http://127.0.0.1:8080/admin/v2').hostname).toBe('127.0.0.1');
    expect(assertSafeBaseUrl('http://localhost:1/x').hostname).toBe('localhost');
    expect(() => assertSafeBaseUrl('http://api.salla.dev/admin/v2')).toThrow(/https/);
    expect(() => assertSafeBaseUrl('ftp://x')).toThrow(/https/);
    expect(() => assertSafeBaseUrl('not a url')).toThrow(/Invalid/);
    expect(() => assertSafeBaseUrl('https://u:p@x.example/')).toThrow(/credentials/);
  });

  it('uses an injected loopback base URL', async () => {
    const fake = fakeFetch({ body: loadFixture('product-details') });
    const c = createSallaClient({ accessToken: TEST_TOKEN, fetch: fake.fetch, baseUrl: 'http://127.0.0.1:9/v2/' });
    await c.get('/products/300001');
    expect(fake.calls[0]!.url.href).toBe('http://127.0.0.1:9/v2/products/300001');
  });

  it('buildUrl omits undefined values and encodes the rest', () => {
    expect(buildUrl('https://h/x', '/orders', { a: undefined, keyword: 'قهوة & tea', light: true })).toBe(
      'https://h/x/orders?keyword=%D9%82%D9%87%D9%88%D8%A9+%26+tea&light=true',
    );
  });
});
