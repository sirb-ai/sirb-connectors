/**
 * Minimal, read-only client for the Salla Merchant API (https://api.salla.dev/admin/v2).
 *
 * - Only ever issues GET requests; there is no method parameter.
 * - The access token is captured in a closure and never appears in results or error values.
 * - `fetch` is injectable so tests replay recorded fixtures without network access.
 */
import { z } from 'zod';

export const SALLA_BASE_URL = 'https://api.salla.dev/admin/v2';
export const DEFAULT_TIMEOUT_MS = 15_000;

export type QueryValue = string | number | boolean | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

export type SallaErrorKind =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'unsuccessful'
  | 'http'
  | 'timeout'
  | 'network'
  | 'invalid_response';

/** A failure description that is safe to show to a model: no token, no upstream body. */
export interface SallaError {
  readonly kind: SallaErrorKind;
  readonly status?: number;
  /** Seconds or HTTP date from `Retry-After`, sanitised. */
  readonly retryAfter?: string;
  /** Value of `X-RateLimit-Reset`, sanitised to digits. */
  readonly rateLimitReset?: string;
}

export type SallaResult =
  | { readonly ok: true; readonly data: unknown; readonly pagination?: unknown }
  | { readonly ok: false; readonly error: SallaError };

export interface SallaClient {
  /** GET `path` (e.g. `/orders/123`) with the given query. Never throws. */
  get(path: string, query?: Query): Promise<SallaResult>;
}

export interface SallaClientOptions {
  readonly accessToken: string;
  readonly fetch?: typeof globalThis.fetch;
  /** For tests only. Must be https, or http on a loopback host. Not exposed via CLI or env. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * Loose envelope check: only `success` and `data` are validated; `pagination` passes through.
 * `data` is optional here because error envelopes (`success: false`) carry `error` instead.
 */
const envelopeSchema = z.looseObject({
  success: z.boolean(),
  data: z.unknown().optional(),
  pagination: z.unknown().optional(),
});

/** Paths are `/segment[/segment...]` with lowercase segments or positive integer ids only. */
const SAFE_PATH = /^(\/(?:[a-z_]+|[1-9][0-9]{0,15}))+$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function assertSafeBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid Salla base URL.');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Salla base URL must use https (plain http is allowed only for loopback hosts).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Salla base URL must not contain credentials, a query or a fragment.');
  }
  return url;
}

/** Builds `base + path + ?query`, omitting undefined values. */
export function buildUrl(baseUrl: string, path: string, query: Query = {}): string {
  if (!SAFE_PATH.test(path)) {
    throw new Error('Unsafe Salla API path.');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return `${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
}

function sanitiseDigits(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^\d{1,12}$/.test(trimmed) ? trimmed : undefined;
}

function sanitiseRetryAfter(value: string | null): string | undefined {
  const digits = sanitiseDigits(value);
  if (digits || !value) return digits;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toUTCString();
}

function errorFromResponse(response: Response): SallaError {
  const status = response.status;
  switch (status) {
    case 401:
    case 403:
      return { kind: 'unauthorized', status };
    case 404:
      return { kind: 'not_found', status };
    case 429: {
      const retryAfter = sanitiseRetryAfter(response.headers.get('retry-after'));
      const rateLimitReset = sanitiseDigits(response.headers.get('x-ratelimit-reset'));
      return {
        kind: 'rate_limited',
        status,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        ...(rateLimitReset !== undefined ? { rateLimitReset } : {}),
      };
    }
    default:
      return { kind: 'http', status };
  }
}

export function createSallaClient(options: SallaClientOptions): SallaClient {
  const accessToken = options.accessToken?.trim();
  if (!accessToken) {
    throw new Error('A Salla access token is required.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl === undefined ? SALLA_BASE_URL : assertSafeBaseUrl(options.baseUrl).href;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async get(path, query) {
      const url = buildUrl(baseUrl, path, query);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          // Never follow a redirect with the bearer token attached.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        return { ok: false, error: { kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' } };
      }

      // Only 2xx is success. Checked explicitly rather than via `response.ok` because `fetch` is
      // injectable; any 1xx/3xx (redirects are refused anyway) or 4xx/5xx is an error.
      if (response.status < 200 || response.status > 299) {
        // Drain without reading the body into anything we return.
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, error: errorFromResponse(response) };
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        return { ok: false, error: { kind: 'invalid_response', status: response.status } };
      }

      const parsed = envelopeSchema.safeParse(json);
      if (!parsed.success) {
        return { ok: false, error: { kind: 'invalid_response', status: response.status } };
      }
      if (!parsed.data.success) {
        return { ok: false, error: { kind: 'unsuccessful', status: response.status } };
      }

      const { data, pagination } = parsed.data;
      if (data === undefined) {
        return { ok: false, error: { kind: 'invalid_response', status: response.status } };
      }
      return pagination === undefined ? { ok: true, data } : { ok: true, data, pagination };
    },
  };
}

/**
 * Turns a `SallaError` into a short message that is safe to hand to a model.
 * It never includes the token, the request URL or any upstream response body.
 */
export function describeSallaError(error: SallaError, scope: string): string {
  switch (error.kind) {
    case 'unauthorized':
      return `Salla rejected the access token or it lacks scope ${scope} (HTTP ${error.status}).`;
    case 'not_found':
      return 'Salla returned 404: the requested resource was not found.';
    case 'rate_limited': {
      const hints = [
        error.retryAfter !== undefined ? `Retry-After: ${error.retryAfter}` : undefined,
        error.rateLimitReset !== undefined ? `X-RateLimit-Reset: ${error.rateLimitReset}` : undefined,
      ].filter(Boolean);
      return `Salla rate limit reached (HTTP 429).${hints.length ? ` ${hints.join('; ')}.` : ''} Wait before retrying.`;
    }
    case 'unsuccessful':
      return 'Salla reported the request as unsuccessful.';
    case 'timeout':
      return 'The Salla request timed out.';
    case 'network':
      return 'Could not reach the Salla API.';
    case 'invalid_response':
      return 'Salla returned a response that could not be read.';
    case 'http':
    default:
      return `Salla request failed (HTTP ${error.status ?? 'unknown'}).`;
  }
}
