/**
 * Shapes what a tool hands to the model (OWASP LLM02 sensitive information disclosure,
 * LLM10 unbounded consumption):
 *
 * - `project()` keeps only allowlisted fields. Orders and customers go through a projection so
 *   bank details, buyer IP / user agent, birthday, gender, street address, receipts and free-text
 *   notes never reach the model.
 * - Keys matching `ALWAYS_DROP` (IBAN, bank details, account numbers, buyer IP, user agent) are
 *   removed at every depth, including inside sub-objects kept with `true`.
 * - Email and mobile are masked unless the operator sets `revealContactDetails`. That switch is
 *   server configuration (CLI flag), never a tool argument, so a model cannot unmask data.
 * - `stripControlChars()` removes C0 control and bidi override characters from every string.
 * - `capPayload()` bounds the serialized result size.
 */

/**
 * `true` keeps a field (deny-filtered); `'email'`/`'phone'` keep it masked unless revealed; an object
 * recurses; `[spec]` maps each array element through `spec`.
 */
export type FieldSpec = true | 'email' | 'phone' | { readonly [field: string]: FieldSpec } | readonly [FieldSpec];

export interface ProjectionOptions {
  /** Return email/mobile unmasked. Operator setting only; defaults to false (masked). */
  readonly revealContactDetails?: boolean;
}

/** Keys never returned at any depth: IBAN, bank details, account numbers, buyer IP, user agent. */
export const ALWAYS_DROP = /iban|bank|swift|account_?number|user_?agent|ip_?address|(?:^|_)ip(?:_|$)/i;

export const isAlwaysDropped = (key: string): boolean => ALWAYS_DROP.test(key);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep copy with every `ALWAYS_DROP` key removed, at any depth. */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isAlwaysDropped(key)) out[key] = scrub(item);
  }
  return out;
}

/** `customer@example.com` → `c***@example.com`. Anything unparseable is fully masked. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  return at < 1 ? '***' : `${value[0]}***${value.slice(at)}`;
}

/** `500000123` → `***23`. Keeps only the last two digits. */
export function maskPhone(value: string | number): string {
  let digits = '';
  for (const ch of String(value)) if (ch >= '0' && ch <= '9') digits += ch;
  return digits.length <= 2 ? '***' : `***${digits.slice(-2)}`;
}

function contact(value: unknown, kind: 'email' | 'phone', reveal: boolean): unknown {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (reveal) return value;
  return kind === 'email' ? maskEmail(String(value)) : maskPhone(value);
}

/** Keeps only the fields named in `spec`. Fields that are absent stay absent; shapes that don't match are dropped. */
export function project(value: unknown, spec: FieldSpec, options: ProjectionOptions = {}): unknown {
  if (spec === true) return scrub(value);
  if (spec === 'email' || spec === 'phone') return contact(value, spec, options.revealContactDetails === true);
  if (Array.isArray(spec)) {
    return Array.isArray(value) ? value.map((item) => project(item, spec[0] as FieldSpec, options)) : undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, fieldSpec] of Object.entries(spec as Record<string, FieldSpec>)) {
    if (isAlwaysDropped(field) || !Object.hasOwn(value, field)) continue;
    const projected = project(value[field], fieldSpec, options);
    if (projected !== undefined) out[field] = projected;
  }
  return out;
}

/** Projects a single record or each record of a list. */
export function projectData(data: unknown, spec: FieldSpec, options: ProjectionOptions = {}): unknown {
  return Array.isArray(data) ? data.map((item) => project(item, spec, options)) : project(data, spec, options);
}

const money = { amount: true, currency: true } as const;

/** Contact fields. Email and mobile are masked unless the operator reveals contact details. */
const CONTACT = {
  first_name: true,
  last_name: true,
  email: 'email',
  mobile: 'phone',
  mobile_code: true,
} as const satisfies Record<string, FieldSpec>;

const ORDER_SPEC: FieldSpec = {
  id: true,
  reference_id: true,
  date: { date: true, timezone: true },
  status: { name: true, slug: true },
  payment_method: true,
  currency: true,
  total: money,
  amounts: { sub_total: money, shipping_cost: money, discounts: true, tax: { amount: money }, total: money },
  items: [{ id: true, name: true, sku: true, quantity: true, amounts: { total: money } }],
  customer: { id: true, ...CONTACT },
};

const CUSTOMER_SPEC: FieldSpec = {
  id: true,
  city: true,
  country: true,
  ...CONTACT,
};

/** Projection for order tools. Never includes bank, source_details, birthday, gender, location, receipt or notes. */
export const projectOrders = (data: unknown, options: ProjectionOptions = {}): unknown =>
  projectData(data, ORDER_SPEC, options);

/** Projection for customer tools. Never includes birthday, gender or street-level location. */
export const projectCustomers = (data: unknown, options: ProjectionOptions = {}): unknown =>
  projectData(data, CUSTOMER_SPEC, options);

// C0 controls except \t \n \r, DEL, and Unicode bidi embedding/override/isolate marks.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩]/g;

/** Returns a deep copy of `value` with control and bidi override characters removed from every string. */
export function stripControlChars(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(CONTROL_CHARS, '');
  if (Array.isArray(value)) return value.map(stripControlChars);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[stripControlChars(key) as string] = stripControlChars(item);
    return out;
  }
  return value;
}

/** Upper bound on the JSON text of one tool result (the same JSON is also sent as structuredContent). */
export const MAX_RESULT_BYTES = 64 * 1024;

export type CappedPayload =
  | { readonly ok: true; readonly payload: Record<string, unknown>; readonly json: string }
  | { readonly ok: false };

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Keeps the serialized payload under `maxBytes`. A list is cut to its longest prefix that fits and
 * marked `truncated: true` with a hint; a single object that does not fit is refused (`ok: false`).
 */
export function capPayload(payload: Record<string, unknown>, maxBytes = MAX_RESULT_BYTES): CappedPayload {
  const json = JSON.stringify(payload);
  if (byteLength(json) <= maxBytes) return { ok: true, payload, json };

  const data = payload.data;
  if (!Array.isArray(data)) return { ok: false };

  // Binary search for the longest prefix of `data` that still fits.
  const build = (count: number): Record<string, unknown> => ({
    ...payload,
    data: data.slice(0, count),
    truncated: true,
    returned_items: count,
    hint: `Result cut to ${count} of ${data.length} items to stay under ${maxBytes} bytes. Use a smaller per_page or narrower filters.`,
  });
  let lo = 0;
  let hi = data.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(JSON.stringify(build(mid))) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const capped = build(lo);
  const cappedJson = JSON.stringify(capped);
  return byteLength(cappedJson) <= maxBytes ? { ok: true, payload: capped, json: cappedJson } : { ok: false };
}
