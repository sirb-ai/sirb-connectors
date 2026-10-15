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
/** Largest Salla response body the client will read. Anything bigger is refused, not buffered. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export type QueryValue = string | number | boolean | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

export type SallaErrorKind =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'validation'
  | 'too_large'
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
  /** For 422: names of the rejected fields (`error.fields` keys), sanitised. Never their messages. */
  readonly fields?: readonly string[];
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
  /** Defaults to `MAX_RESPONSE_BYTES`. */
  readonly maxResponseBytes?: number;
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
  return `${trimTrailingSlashes(baseUrl)}${path}${qs ? `?${qs}` : ''}`;
}

/** Linear-time trailing-slash trim; avoids a `/\/+$/` regex, which is quadratic on many inner '/'. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
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

class ResponseTooLargeError extends Error {}

/** Reads the body as text, refusing more than `maxBytes` (checked on Content-Length and while streaming). */
async function readBodyLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  if (!response.body) {
    // Non-standard fetch implementations may not expose a stream.
    return typeof response.text === 'function' ? response.text() : JSON.stringify(await response.json());
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FIELDS = 10;

/** Extracts the keys of a 422 body's `error.fields`, keeping only short snake_case names. */
async function validationFields(response: Response): Promise<string[]> {
  try {
    const body = JSON.parse(await readBodyLimited(response, 64 * 1024)) as { error?: { fields?: unknown } };
    const fields = body?.error?.fields;
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return [];
    return Object.keys(fields).filter((name) => FIELD_NAME.test(name)).slice(0, MAX_FIELDS);
  } catch {
    return [];
  }
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
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;

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
        if (response.status === 422) {
          // Only the field *names* are kept; Salla's messages are never echoed.
          return { ok: false, error: { kind: 'validation', status: 422, fields: await validationFields(response) } };
        }
        // Drain without reading the body into anything we return.
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, error: errorFromResponse(response) };
      }

      let json: unknown;
      try {
        json = JSON.parse(await readBodyLimited(response, maxResponseBytes));
      } catch (err) {
        const kind = err instanceof ResponseTooLargeError ? 'too_large' : 'invalid_response';
        return { ok: false, error: { kind, status: response.status } };
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
    case 'validation':
      return error.fields?.length
        ? `Salla rejected the request (HTTP 422). Invalid fields: ${error.fields.join(', ')}.`
        : 'Salla rejected the request as invalid (HTTP 422).';
    case 'too_large':
      return 'The Salla response was too large to process. Use a smaller per_page, narrower filters or light format.';
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
