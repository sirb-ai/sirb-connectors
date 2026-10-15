/**
 * Shapes what a tool hands to the model (OWASP LLM02 sensitive information disclosure,
 * LLM10 unbounded consumption):
 *
 * - `project()` keeps only allowlisted fields. Orders and customers go through a projection so
 *   bank details, buyer IP / user agent, birthday, gender, street address, receipts and free-text
 *   notes never reach the model. Contact fields (name, email, mobile) are opt-in per call.
 * - `stripControlChars()` removes C0 control and bidi override characters from every string.
 * - `capPayload()` bounds the serialized result size.
 */

/** `true` keeps a field as is; an object recurses; `[spec]` maps each array element through `spec`. */
export type FieldSpec = true | { readonly [field: string]: FieldSpec } | readonly [FieldSpec];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keeps only the fields named in `spec`. Fields that are absent stay absent; shapes that don't match are dropped. */
export function project(value: unknown, spec: FieldSpec): unknown {
  if (spec === true) return value;
  if (Array.isArray(spec)) {
    return Array.isArray(value) ? value.map((item) => project(item, spec[0] as FieldSpec)) : undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, fieldSpec] of Object.entries(spec as Record<string, FieldSpec>)) {
    if (!Object.hasOwn(value, field)) continue;
    const projected = project(value[field], fieldSpec);
    if (projected !== undefined) out[field] = projected;
  }
  return out;
}

/** Projects a single record or each record of a list. */
export function projectData(data: unknown, spec: FieldSpec): unknown {
  return Array.isArray(data) ? data.map((item) => project(item, spec)) : project(data, spec);
}

const money = { amount: true, currency: true } as const;

/** Contact fields, returned only when the caller passes `include_contact: true`. */
const CONTACT = { first_name: true, last_name: true, email: true, mobile: true, mobile_code: true } as const;

const orderSpec = (includeContact: boolean): FieldSpec => ({
  id: true,
  reference_id: true,
  date: { date: true, timezone: true },
  status: { name: true, slug: true },
  payment_method: true,
  currency: true,
  total: money,
  amounts: { sub_total: money, shipping_cost: money, discounts: true, tax: { amount: money }, total: money },
  items: [{ id: true, name: true, sku: true, quantity: true, amounts: { total: money } }],
  customer: includeContact ? { id: true, ...CONTACT } : { id: true },
});

const customerSpec = (includeContact: boolean): FieldSpec => ({
  id: true,
  city: true,
  country: true,
  ...(includeContact ? CONTACT : {}),
});

/** Projection for order tools. Never includes bank, source_details, birthday, gender, location, receipt or notes. */
export const projectOrders = (data: unknown, includeContact = false): unknown =>
  projectData(data, orderSpec(includeContact));

/** Projection for customer tools. Never includes birthday, gender or street-level location. */
export const projectCustomers = (data: unknown, includeContact = false): unknown =>
  projectData(data, customerSpec(includeContact));

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
