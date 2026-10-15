/**
 * Redaction helpers. Anything this package writes to a log goes through `redact()` first so an
 * access token can never reach stderr, even if it is embedded in an error message or header dump.
 */

const REDACTED = '[REDACTED]';

/** Matches `Bearer <token>` (RFC 6750 b64token) anywhere in a string. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** Matches `access_token=...` / `"access_token":"..."` style fragments. */
const TOKEN_FIELD_PATTERN = /(access_token|refresh_token|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi;

/**
 * Removes bearer tokens, token-like fields and any explicitly supplied secrets from `input`.
 * Pure: it never throws and accepts any value (non-strings are stringified first).
 */
export function redact(input: unknown, secrets: readonly (string | undefined)[] = []): string {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Error) {
    text = `${input.name}: ${input.message}`;
  } else {
    try {
      text = JSON.stringify(input) ?? String(input);
    } catch {
      text = String(input);
    }
  }

  for (const secret of secrets) {
    // Very short strings would redact ordinary words; real tokens are long.
    if (secret && secret.length >= 8) {
      text = text.split(secret).join(REDACTED);
    }
  }

  return text
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(TOKEN_FIELD_PATTERN, `$1$2${REDACTED}`);
}
