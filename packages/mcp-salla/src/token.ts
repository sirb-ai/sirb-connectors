/** Shared bearer-token syntax check (RFC 6750 `b64token`) for both HTTP and stdio transports. */

export const MAX_TOKEN_LENGTH = 4096;

const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** True if `value` is a syntactically valid OAuth 2.0 bearer token. Never logs or echoes it. */
export function isValidBearerToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_LENGTH && B64TOKEN.test(value);
}
