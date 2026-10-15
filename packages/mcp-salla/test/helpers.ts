import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEST_TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz-0123456789';

export function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

export interface RecordedCall {
  readonly url: URL;
  readonly init: RequestInit;
  readonly headers: Headers;
}

export interface FakeResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly headers?: Record<string, string>;
}

/** A `fetch` replacement that replays canned responses and records every call. No network. */
export function fakeFetch(respond: FakeResponse | ((url: URL) => FakeResponse)) {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init, headers: new Headers(init.headers) });
    const r = typeof respond === 'function' ? respond(url) : respond;
    const body = r.rawBody ?? JSON.stringify(r.body ?? {});
    return new Response(body, {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...r.headers },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
