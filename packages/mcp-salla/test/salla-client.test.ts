import { describe, expect, it } from 'vitest';
import {
  assertSafeBaseUrl,
  buildUrl,
  createSallaClient,
  describeSallaError,
  SALLA_BASE_URL,
  trimTrailingSlashes,
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

  it('buildUrl strips any number of trailing slashes from the base URL', () => {
    expect(buildUrl('https://h/x///', '/orders')).toBe('https://h/x/orders');
  });

  it('trimTrailingSlashes handles edge cases', () => {
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('a/b')).toBe('a/b');
    expect(trimTrailingSlashes('a/b//')).toBe('a/b');
  });

  it('trimTrailingSlashes stays linear on many inner slashes (CodeQL js/polynomial-redos)', () => {
    const hostile = `${'/'.repeat(200_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('response size limit', () => {
  const jsonStream = (chunks: number, chunkBytes: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":true,"data":"'));
        for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(chunkBytes).fill(0x78));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });

  it('refuses a body whose Content-Length is over the limit without reading it', async () => {
    // A body that never ends: reading it at all would hang the test.
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const fetch = (async () =>
      new Response(body, { status: 200, headers: { 'Content-Length': '2000' } })) as typeof globalThis.fetch;
    const result = await createSallaClient({ accessToken: TEST_TOKEN, fetch, maxResponseBytes: 1000 }).get('/orders');
    expect(result).toEqual({ ok: false, error: { kind: 'too_large', status: 200 } });
    expect(cancelled).toBe(true);
  });

  it('stops reading a streamed body once it passes the limit', async () => {
    const fetch = (async () => new Response(jsonStream(100, 100), { status: 200 })) as typeof globalThis.fetch;
    const result = await createSallaClient({ accessToken: TEST_TOKEN, fetch, maxResponseBytes: 1000 }).get('/orders');
    expect(result).toEqual({ ok: false, error: { kind: 'too_large', status: 200 } });
    expect(describeSallaError({ kind: 'too_large' }, 'orders.read')).toMatch(/too large/);
  });

  it('reads a body under the limit, including multi-byte text split across chunks', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ success: true, data: 'قهوة' }));
    const fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const b of bytes) c.enqueue(new Uint8Array([b]));
            c.close();
          },
        }),
      )) as typeof globalThis.fetch;
    const result = await createSallaClient({ accessToken: TEST_TOKEN, fetch }).get('/orders');
    expect(result).toEqual({ ok: true, data: 'قهوة' });
  });

  it('falls back to text() for a fetch that exposes no stream', async () => {
    const fetch = (async () => ({
      status: 200,
      headers: new Headers(),
      body: null,
      text: async () => JSON.stringify({ success: true, data: [1] }),
    })) as unknown as typeof globalThis.fetch;
    const result = await createSallaClient({ accessToken: TEST_TOKEN, fetch }).get('/orders');
    expect(result).toEqual({ ok: true, data: [1] });
  });
});

describe('422 validation errors', () => {
  it('keeps only sanitised field names, never messages', async () => {
    const fields = Object.fromEntries(
      ['status', 'Bad Name', 'per_page', ...Array.from({ length: 20 }, (_, i) => `f${i}`)].map((k) => [k, ['msg']]),
    );
    const { client: c } = client({ status: 422, body: { success: false, error: { message: 'leak', fields } } });
    const result = await c.get('/orders');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
    expect(result.error.fields).toHaveLength(10);
    expect(result.error.fields!.slice(0, 2)).toEqual(['status', 'per_page']);
    expect(JSON.stringify(result)).not.toContain('leak');
  });

  it('tolerates a 422 body that is not JSON or has no fields', async () => {
    for (const r of [{ status: 422, rawBody: 'nope' }, { status: 422, body: { error: { fields: ['a'] } } }]) {
      const result = await client(r).client.get('/orders');
      expect(result).toEqual({ ok: false, error: { kind: 'validation', status: 422, fields: [] } });
    }
  });
});
